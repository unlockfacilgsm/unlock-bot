'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { Store } = require('./src/store');
const { normalizeEncryptionKey } = require('./src/crypto');
const { DiscordTransport, ensureDataChannel, fetchAllMessages, CHANNEL_NAMES } = require('./src/transport');
const { migrateLegacy } = require('./src/migration');
const { BotApp } = require('./src/app');
const catalog = require('./src/catalog');
const { formatDiscordError, safeErrorDetails } = require('./src/discord-errors');

function validateEnvironment(env) {
  for (const name of ['DISCORD_TOKEN', 'GUILD_ID', 'ENCRYPTION_KEY']) {
    if (!env[name]?.trim()) throw new Error(`${name} não foi configurado no .env.`);
  }
  if (!/^\d+$/.test(env.GUILD_ID)) throw new Error('GUILD_ID deve conter o ID numérico do servidor.');
  for (const name of ['ADMIN_ROLE_ID', 'SELLER_ROLE_ID', 'DISCORD_DATA_CHANNEL_ID']) {
    if (env[name] && !/^\d+$/.test(env[name])) throw new Error(`${name} deve ser um ID numérico.`);
  }
  normalizeEncryptionKey(env.ENCRYPTION_KEY);
}

function createClient() {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
}

async function legacyHistoryExists(guild, botId, store) {
  if (await store.getConfig(guild.id, 'migrationCompleted', false)) return false;
  if ((await store.listRecords(guild.id, 'vendas')).length) return false;
  const mapped = await store.getConfig(guild.id, 'channels', {});
  for (const channel of guild.channels.cache.values()) {
    if (channel.name !== CHANNEL_NAMES.vendas || channel.id === mapped.vendas || !channel.messages) continue;
    const messages = await fetchAllMessages(channel);
    if (messages.some(message => message.author?.id === botId && /^🔖 ID: VEN-\d+$/m.test(message.content))) return true;
  }
  return false;
}

async function start({ env = process.env, client = createClient(), logger = console } = {}) {
  validateEnvironment(env);
  let app;
  let store;
  let interval;
  const ready = new Promise((resolve, reject) => {
    client.once('clientReady', async connected => {
      let stage = 'acesso ao servidor';
      try {
        const guild = connected.guilds.cache.get(env.GUILD_ID) || await connected.guilds.fetch(env.GUILD_ID);
        stage = 'acesso ao canal de dados';
        const channel = await ensureDataChannel(guild, { client: connected, channelId: env.DISCORD_DATA_CHANNEL_ID, adminRoleId: env.ADMIN_ROLE_ID, sellerRoleId: env.SELLER_ROLE_ID });
        store = new Store({ channel, guildId: guild.id, botId: connected.user.id, encryptionKey: env.ENCRYPTION_KEY });
        stage = 'leitura do armazenamento';
        await store.load();
        const transport = new DiscordTransport({ client: connected, store, catalog });
        app = new BotApp({ client: connected, store, transport, migrate: migrateLegacy, guildId: guild.id, adminRoleId: env.ADMIN_ROLE_ID, sellerRoleId: env.SELLER_ROLE_ID, logger });
        stage = 'leitura do histórico antigo';
        if (await legacyHistoryExists(guild, connected.user.id, store)) {
          app.requiresMigration = true;
          logger.log('Histórico antigo encontrado. Execute /configurar e /migrar antes de novas vendas.');
        }
        const channels = await store.getConfig(guild.id, 'channels', {});
        if (!channels.painel || !channels.backups) logger.log('Configuração incompleta. Execute /configurar para concluir os canais; tarefas automáticas aguardam a configuração.');
        // A partially configured server must remain online so /configurar can
        // repair its channels. A failed task remains in the durable queue.
        const runTick = () => app.tick(guild).catch(error => logger.error(`Verificação pendente: ${safeErrorDetails(error, { env })}`));
        await runTick();
        interval = setInterval(runTick, 30_000);
        logger.log(`🤖 Online como ${connected.user.tag}. Dados mantidos no Discord, canal ${channel.id}.`);
        resolve({ client, app, store, transport, guild, stop });
      } catch (error) {
        error.botContext = stage;
        client.destroy();
        reject(error);
      }
    });
  });

  client.on('interactionCreate', async interaction => {
    if (app) return app.handle(interaction);
    if (interaction.isAutocomplete?.()) return interaction.respond([]).catch(() => {});
    if (interaction.isChatInputCommand?.()) {
      await interaction.reply({ content: 'O bot está carregando o histórico. Tente novamente em alguns instantes.', flags: 64, allowedMentions: { parse: [] } }).catch(() => {});
    }
  });
  client.on('error', error => logger.error(`Discord: ${safeErrorDetails(error, { env })}`));

  async function stop() {
    clearInterval(interval);
    if (app) {
      app.stopping = true;
      try { await app.runningTick; } catch { /* The durable queue resumes on restart. */ }
    }
    await store?.close();
    client.destroy();
  }

  try {
    await client.login(env.DISCORD_TOKEN);
    return await ready;
  } catch (error) {
    await stop();
    throw error;
  }
}

if (require.main === module) {
  let running;
  const shutdown = () => running?.stop().finally(() => { process.exitCode = 0; });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('uncaughtException', error => {
    console.error(`Erro fatal: ${safeErrorDetails(error)}. Reinicie o bot para retomar as operações.`);
    if (running) running.client.destroy();
    process.exitCode = 1;
    process.exit(1);
  });
  process.once('unhandledRejection', error => {
    console.error(`Falha não tratada: ${safeErrorDetails(error)}. Reinicie o bot para retomar as operações.`);
    if (running) running.client.destroy();
    process.exitCode = 1;
    process.exit(1);
  });
  start().then(result => { running = result; }).catch(error => {
    console.error(`Não foi possível iniciar o bot: ${formatDiscordError(error)}`);
    console.error(safeErrorDetails(error));
    process.exitCode = 1;
  });
}

module.exports = { start, createClient, validateEnvironment, legacyHistoryExists };

'use strict';

const { once } = require('node:events');
const { createClient, validateEnvironment } = require('../index');
const { Store } = require('../src/store');
const { CHANNEL_NAMES, fetchAllMessages } = require('../src/transport');
const { auditLegacy } = require('../src/legacy-audit');
const { cleanupLegacy } = require('../src/legacy-cleanup');
const { safeErrorDetails } = require('../src/discord-errors');

async function loadStore(guild, client, env) {
  const candidates = [...guild.channels.cache.values()].filter(channel => channel.topic?.startsWith('UF4: armazenamento criptografado') || channel.name === CHANNEL_NAMES.dados);
  const channel = env.DISCORD_DATA_CHANNEL_ID ? await guild.channels.fetch(env.DISCORD_DATA_CHANNEL_ID) : candidates.length === 1 ? candidates[0] : null;
  if (!channel) throw new Error('Não foi possível identificar o canal original de dados.');
  const history = await fetchAllMessages(channel);
  const attachments = history.filter(message => message.author?.id === client.user.id).flatMap(message => [...message.attachments.values()])
    .filter(file => ['unlock-event.json', 'unlock-snapshot.json'].includes(file.name));
  const buffers = new Map(); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, attachments.length) }, async () => {
    while (cursor < attachments.length) {
      const file = attachments[cursor++];
      const response = await fetch(file.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Não foi possível ler o histórico (${response.status}).`);
      buffers.set(file.url, Buffer.from(await response.arrayBuffer()));
    }
  }));
  const store = new Store({ channel, guildId: guild.id, botId: client.user.id, encryptionKey: env.ENCRYPTION_KEY,
    downloadAttachment: async url => {
      if (buffers.has(url)) return buffers.get(url);
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Falha ao ler evento novo (${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    } });
  await store.load();
  return store;
}

async function main() {
  require('dotenv').config({ quiet: true });
  validateEnvironment(process.env);
  const client = createClient();
  try {
    const ready = once(client, 'clientReady', { signal: AbortSignal.timeout(30000) });
    await client.login(process.env.DISCORD_TOKEN); await ready;
    const guild = await client.guilds.fetch(process.env.GUILD_ID); await guild.channels.fetch();
    const store = await loadStore(guild, client, process.env);
    const result = process.argv.includes('--cleanup')
      ? await cleanupLegacy({ guild, client, store, encryptionKey: process.env.ENCRYPTION_KEY, progress: text => console.log(text) })
      : (await auditLegacy({ guild, client, store })).report;
    console.log(JSON.stringify(result, null, 2));
    await store.close();
  } finally { client.destroy(); }
}

if (require.main === module) main().catch(error => { console.error(safeErrorDetails(error)); process.exitCode = 1; });
module.exports = { loadStore, main };

'use strict';

const { once } = require('node:events');
const { createClient, validateEnvironment } = require('../index');
const { Store } = require('../src/store');
const { CHANNEL_NAMES, DiscordTransport } = require('../src/transport');
const { refreshRecords, refreshLegacyRecords } = require('../src/record-refresh');
const { safeErrorDetails } = require('../src/discord-errors');
const catalog = require('../src/catalog');

async function main() {
  require('dotenv').config({ quiet: true });
  validateEnvironment(process.env);
  const client = createClient();
  try {
    const ready = once(client, 'clientReady', { signal: AbortSignal.timeout(30000) });
    await client.login(process.env.DISCORD_TOKEN);
    await ready;
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.channels.fetch();
    const dryRun = !process.argv.includes('--apply');
    if (process.argv.includes('--legacy-only')) {
      const report = await refreshLegacyRecords({ guild, client, dryRun });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.errors.length ? 1 : 0;
      return;
    }
    let data;
    if (process.env.DISCORD_DATA_CHANNEL_ID) data = await guild.channels.fetch(process.env.DISCORD_DATA_CHANNEL_ID);
    else {
      const candidates = [...guild.channels.cache.values()].filter(channel => channel.topic?.startsWith('UF4: armazenamento criptografado') || channel.name === CHANNEL_NAMES.dados);
      if (candidates.length !== 1) throw new Error('Selecione o canal original em DISCORD_DATA_CHANNEL_ID antes de atualizar mensagens.');
      [data] = candidates;
    }
    const store = new Store({ channel: data, guildId: guild.id, botId: client.user.id, encryptionKey: process.env.ENCRYPTION_KEY });
    await store.load();
    const report = await refreshRecords({ guild, client, store, dryRun, progress: text => console.log(text) });
    report.legacy = await refreshLegacyRecords({ guild, client, dryRun });
    if (!dryRun && !report.errors.length) await new DiscordTransport({ client, store, catalog }).setupCommands(guild);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length || report.legacy.errors.length ? 1 : 0;
    await store.close();
  } finally { client.destroy(); }
}

if (require.main === module) main().catch(error => { console.error(safeErrorDetails(error)); process.exitCode = 1; });
module.exports = { main };

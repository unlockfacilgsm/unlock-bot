'use strict';

const { ChannelType } = require('discord.js');
const { CHANNEL_NAMES, fetchAllMessages } = require('./transport');
const { parseLegacyRecord, parseFreeCredentials } = require('./migration');
const catalog = require('./catalog');

async function auditLegacy({ guild, client, store }) {
  const mapped = await store.getConfig(guild.id, 'channels', {});
  const currentIds = new Set(Object.values(mapped));
  const names = new Set([...['painel', 'comandos', 'vendas', 'vencimentos', 'trocas', 'renovacoes'].map(type => CHANNEL_NAMES[type]),
    ...Object.values(catalog.TOOLS).map(tool => tool.channelName), '🔐・trocas-de-senha', '🆓・contas-livres']);
  const currentCategories = new Set(Object.values(await store.getConfig(guild.id, 'categories', {})));
  const legacyParents = new Set([...guild.channels.cache.values()].filter(channel => channel.type === ChannelType.GuildCategory &&
    ['📁 UNLOCK FÁCIL', '📁・CONTAS LIVRES'].includes(channel.name) && !currentCategories.has(channel.id)).map(channel => channel.id));
  const targets = [...guild.channels.cache.values()].filter(channel => channel.type === ChannelType.GuildText &&
    (channel.name.startsWith('arquivo-') || legacyParents.has(channel.parentId)) &&
    names.has(channel.name.replace(/^arquivo-/, '')) && !currentIds.has(channel.id));
  const records = (await Promise.all(['vendas', 'vencimentos', 'trocas', 'renovacoes'].map(type => store.listRecords(guild.id, type)))).flat();
  const accounts = await store.listAccounts(guild.id);
  const report = { oldSales: 0, currentSales: records.filter(record => record.type === 'vendas').length, matchedSales: 0,
    credentialGaps: [], differences: [], missingRecords: [], newSales: [], accountGaps: [], errors: [], channels: [] };
  const sources = [], matched = new Set();
  const bySource = new Map(records.filter(record => record.legacyMessageId).map(record => [`${record.legacyChannelId}:${record.legacyMessageId}`, record]));
  const batches = await Promise.allSettled(targets.map(channel => fetchAllMessages(channel)));
  for (const [index, batch] of batches.entries()) {
    const channel = targets[index];
    if (batch.status !== 'fulfilled') { report.errors.push({ channelId: channel.id, reason: 'Não foi possível ler todo o histórico.' }); continue; }
    const messages = batch.value;
    sources.push({ channel, messages });
    report.channels.push({ id: channel.id, name: channel.name, messages: messages.length });
    const tool = Object.keys(catalog.TOOLS).find(name => catalog.TOOLS[name].channelName === channel.name.replace(/^arquivo-/, ''));
    for (const message of messages) {
      if (message.author?.id !== client.user.id) continue;
      let old;
      try { old = parseLegacyRecord(message, catalog.TOOLS); }
      catch { report.errors.push({ channelId: channel.id, messageId: message.id, reason: 'Registro antigo não pôde ser interpretado com segurança.' }); continue; }
      if (!old) {
        if (tool) for (const credential of parseFreeCredentials(message, tool)) {
          if (!accounts.some(account => account.tool === credential.tool && account.login === credential.login)) {
            report.accountGaps.push({ channelId: channel.id, messageId: message.id, tool });
          }
        }
        continue;
      }
      if (old.type === 'vendas') report.oldSales++;
      const current = bySource.get(`${channel.id}:${message.id}`);
      if (!current) { report.missingRecords.push({ type: old.type, id: old.id, channelId: channel.id, messageId: message.id }); continue; }
      matched.add(current.id);
      const fields = ['client', 'tool', 'registeredAt', ...(old.login !== undefined ? ['login'] : []), ...(old.expiresAt ? ['expiresAt'] : [])];
      const differences = fields.filter(field => current[field] !== old[field]);
      if (old.plan && (current.currentPlan || current.plan) !== old.plan) differences.push('plan');
      if (differences.length) report.differences.push({ type: old.type, oldId: old.id, currentId: current.id, fields: differences });
      if (old.type === 'vendas') {
        const display = await store.getDisplayRecord(guild.id, 'vendas', current.id);
        if (display.password === undefined) report.credentialGaps.push({ id: current.id, channelId: channel.id, messageId: message.id });
        else if (display.password !== old.password) report.differences.push({ type: old.type, oldId: old.id, currentId: current.id, fields: ['password'] });
        if (!differences.length && display.password === old.password) report.matchedSales++;
      }
    }
  }
  report.newSales = records.filter(record => record.type === 'vendas' && !matched.has(record.id)).map(record => record.id);
  report.ok = targets.length > 0 && ![report.credentialGaps, report.differences, report.missingRecords, report.accountGaps, report.errors].some(items => items.length);
  return { report, sources };
}

module.exports = { auditLegacy };

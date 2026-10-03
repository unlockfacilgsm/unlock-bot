'use strict';

const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { DiscordTransport, fetchAllMessages, recordPages, recordBlock, RECORD_SEPARATOR, CHANNEL_NAMES } = require('./transport');
const { parseLegacyRecord } = require('./migration');
const catalog = require('./catalog');
const { safeErrorDetails } = require('./discord-errors');

function privateChannel(guild, channel) {
  const permissions = channel.permissionsFor?.(guild.roles.everyone);
  if (channel.type !== ChannelType.GuildText || !permissions || permissions.has(P.ViewChannel)) {
    throw new Error(`O canal ${channel.id} precisa ser privado antes de exibir os registros.`);
  }
}

/** Update display messages only: never rewrite ledger events or legacy sources. */
async function refreshRecords({ guild, client, store, dryRun = true, progress = () => {} }) {
  const result = { dryRun, records: 0, changed: 0, unchanged: 0, missing: 0, unavailablePasswords: 0, errors: [] };
  const transport = new DiscordTransport({ client, store, catalog });
  const mapped = await store.getConfig(guild.id, 'channels', {});
  const cache = new Map();
  for (const type of ['vendas', 'vencimentos', 'renovacoes', 'trocas']) {
    const rows = await store.listRecords(guild.id, type);
    if (!rows.length) continue;
    const channel = mapped[type] && (guild.channels.cache.get(mapped[type]) || await guild.channels.fetch(mapped[type]));
    if (!channel) { result.missing += rows.length; continue; }
    privateChannel(guild, channel);
    const messages = await fetchAllMessages(channel);
    cache.set(channel.id, messages);
    for (const row of rows) {
      if (!row.messageId) { result.missing++; continue; }
      try {
        await store.transaction(async () => {
          const record = await store.getDisplayRecord(guild.id, type, row.id);
          if (!record) { result.missing++; return; }
          const message = messages.find(item => item.id === record.messageId);
          if (!message) { result.missing++; return; }
          if (message.author?.id !== client.user.id) throw new Error('Mensagem mapeada não pertence ao bot.');
          const marker = message.content.split('\n').find(line => /^UF4:record:[A-Za-z0-9_-]+$/.test(line));
          if (!marker) throw new Error('Mensagem mapeada não possui marcador de publicação reconhecido.');
          result.records++;
          if (type === 'vendas' && record.password === undefined) result.unavailablePasswords++;
          const item = { kind: 'record', id: marker.slice('UF4:record:'.length) };
          const pages = recordPages(record, marker);
          for (const [page, body] of pages.entries()) {
            const pageMarker = `${marker}${page ? `:${page}` : ''}`;
            const existing = page === 0 ? message : messages.find(item => item.author?.id === client.user.id && item.content.split('\n').includes(pageMarker));
            if (existing?.content === body) { result.unchanged++; continue; }
            if (!dryRun) await transport.publish(channel, item, recordPages(record)[page], { messageId: existing?.id, page, cache });
            result.changed++;
          }
        });
      } catch (error) { result.errors.push({ type, id: row.id, error: safeErrorDetails(error) }); }
      if (result.records % 20 === 0) progress(`Registros verificados: ${result.records}; mensagens ${dryRun ? 'a atualizar' : 'atualizadas'}: ${result.changed}.`);
    }
  }
  // Existing account and reminder messages keep their fields and attachments.
  const otherIds = new Set([mapped.alertas, ...Object.values(catalog.TOOLS).map(tool => mapped[tool.channelKey])].filter(Boolean));
  for (const id of otherIds) {
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id);
    if (!channel) continue;
    privateChannel(guild, channel);
    for (const message of await fetchAllMessages(channel)) {
      if (message.author?.id !== client.user.id || !/^UF4:(?:account|free-account|reminder):[A-Za-z0-9_-]+$/m.test(message.content)) continue;
      if (message.content.startsWith(`${RECORD_SEPARATOR}\n`) && message.content.endsWith(`\n${RECORD_SEPARATOR}`)) { result.unchanged++; continue; }
      if (!dryRun) await message.edit({ content: recordBlock(message.content), allowedMentions: { parse: [] } });
      result.changed++;
    }
  }
  return result;
}

async function refreshLegacyRecords({ guild, client, dryRun = true }) {
  const result = { dryRun, changed: 0, unchanged: 0, errors: [] };
  const names = new Set(['vendas', 'vencimentos', 'renovacoes', 'trocas'].map(type => `arquivo-${CHANNEL_NAMES[type]}`));
  const labels = { vendas: 'VENDA', vencimentos: 'VENCIMENTO', renovacoes: 'RENOVAÇÃO', trocas: 'TROCA' };
  for (const channel of guild.channels.cache.values()) {
    if (!names.has(channel.name)) continue;
    privateChannel(guild, channel);
    for (const message of await fetchAllMessages(channel)) {
      if (message.author?.id !== client.user.id) continue;
      try {
        const record = parseLegacyRecord(message, catalog.TOOLS);
        if (!record) continue;
        const lines = message.content.split('\n').filter(line => !/^(?:━{5,}|-{5,})$/u.test(line.trim()));
        const header = `**${labels[record.type]} ${record.id}**`;
        const oldHeader = lines.findIndex(line => /^📌\s/.test(line));
        if (oldHeader >= 0) lines[oldHeader] = header;
        else if (!lines.includes(header)) lines.unshift(header);
        const content = recordBlock(lines.join('\n'));
        if (content === message.content) { result.unchanged++; continue; }
        if (content.length > 2000) throw new Error('Registro antigo excederia o limite de mensagens; preservado sem alteração.');
        if (!dryRun) await message.edit({ content, allowedMentions: { parse: [] } });
        result.changed++;
      } catch (error) { result.errors.push({ channelId: channel.id, messageId: message.id, error: safeErrorDetails(error) }); }
    }
  }
  return result;
}

module.exports = { refreshRecords, refreshLegacyRecords, privateChannel };

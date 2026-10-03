'use strict';

const { createHash } = require('node:crypto');
const { SNAPSHOT_FORMAT } = require('./store');
const { PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { auditLegacy } = require('./legacy-audit');
const { parseLegacyRecord } = require('./migration');
const { privateChannel } = require('./record-refresh');
const { encryptString, decryptString } = require('./crypto');
const catalog = require('./catalog');

function hasBlockingDifferences(report) {
  return [report.differences, report.missingRecords, report.accountGaps, report.errors].some(items => items.length);
}

async function cleanupLegacy({ guild, client, store, encryptionKey, progress = () => {} }) {
  let audit = await auditLegacy({ guild, client, store });
  if (hasBlockingDifferences(audit.report) || !audit.sources.length) return { deleted: [], report: audit.report };
  const mapped = await store.getConfig(guild.id, 'channels', {});
  const backupChannel = mapped.backups && (guild.channels.cache.get(mapped.backups) || await guild.channels.fetch(mapped.backups));
  if (!backupChannel) throw new Error('O canal de backups precisa existir antes de remover o histórico antigo.');
  privateChannel(guild, backupChannel);
  const member = guild.members.me || await guild.members.fetchMe();
  for (const { channel } of audit.sources) {
    if (!channel.permissionsFor(member)?.has(P.ManageChannels)) throw new Error(`O bot não pode excluir o canal antigo ${channel.id}.`);
  }
  let preservedPasswords = 0;
  for (const gap of audit.report.credentialGaps) {
    const source = audit.sources.find(item => item.channel.id === gap.channelId);
    const message = source.messages.find(item => item.id === gap.messageId);
    const parsed = parseLegacyRecord(message, catalog.TOOLS);
    await store.preserveLegacySalePassword(guild.id, { saleId: gap.id, source: parsed, actorId: client.user.id });
    preservedPasswords++;
  }
  // Store transactions clone returned values; keep SDK objects outside that result.
  await store.transaction(async () => { audit = await auditLegacy({ guild, client, store }); });
  if (!audit.report.ok) return { deleted: [], preservedPasswords, report: audit.report };
  progress(`Comparação confirmada: ${audit.report.matchedSales}/${audit.report.oldSales} vendas antigas preservadas; ${audit.report.newSales.length} novas.`);
  const archive = { guildId: guild.id, createdAt: new Date().toISOString(), report: audit.report, channels: [] };
  for (const { channel, messages } of audit.sources) {
    const saved = { id: channel.id, name: channel.name, parentId: channel.parentId, topic: channel.topic,
      permissions: [...channel.permissionOverwrites.cache.values()].map(rule => rule.toJSON()), messages: [] };
    for (const message of messages) {
      const entry = { id: message.id, authorId: message.author?.id, content: message.content,
        createdAt: message.createdAt?.toISOString(), embeds: message.embeds?.map(embed => embed.toJSON()), attachments: [] };
      for (const file of message.attachments.values()) {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Não foi possível preservar um anexo antigo; os canais não foram excluídos.');
        entry.attachments.push({ name: file.name, data: Buffer.from(await response.arrayBuffer()).toString('base64') });
      }
      saved.messages.push(entry);
    }
    archive.channels.push(saved);
  }
  const context = `legacy-archive:${guild.id}`;
  const encrypted = encryptString(JSON.stringify(archive), encryptionKey, context);
  if (decryptString(encrypted, encryptionKey, context) !== JSON.stringify(archive)) throw new Error('A verificação do backup antigo falhou.');
  const snapshot = await store.exportSnapshot();
  const envelope = JSON.parse(snapshot.toString('utf8'));
  if (envelope.format !== SNAPSHOT_FORMAT || envelope.guildId !== guild.id || envelope.encrypted !== true || envelope.state || !envelope.data) {
    throw new Error('O backup do estado atual precisa estar criptografado; canais antigos preservados.');
  }
  const files = [
    { name: `unlock-backup-${guild.id}.json`, attachment: snapshot },
    { name: `unlock-legacy-${guild.id}.json`, attachment: Buffer.from(JSON.stringify({ format: 'unlock-bot-legacy-archive-v1', guildId: guild.id, encrypted: true, context, data: encrypted })) }
  ];
  if (files.some(file => file.attachment.length > 8 * 1024 * 1024)) throw new Error('Backup excede o limite seguro de anexos; canais antigos preservados.');
  const backup = await backupChannel.send({ content: 'Backup criptografado verificado antes da remoção dos canais antigos. Inclui o estado atual e o histórico original completo.', files, allowedMentions: { parse: [] } });
  for (const file of files) {
    const remote = [...backup.attachments.values()].find(attachment => attachment.name === file.name);
    if (!remote) throw new Error('O Discord não confirmou todos os anexos; os canais antigos foram preservados.');
    const response = await fetch(remote.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Não foi possível verificar o backup no Discord; canais preservados.');
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = data => createHash('sha256').update(data).digest('hex');
    if (hash(bytes) !== hash(file.attachment)) throw new Error('Backup recebido não corresponde ao original; canais preservados.');
  }
  // Recheck sources and the latest ledger after the backup upload.
  let final;
  await store.transaction(async () => { final = await auditLegacy({ guild, client, store }); });
  const signature = sources => JSON.stringify(sources.map(source => ({ id: source.channel.id,
    messages: source.messages.map(message => ({ id: message.id, content: message.content, attachments: [...message.attachments.values()].map(file => ({ name: file.name, url: file.url })) })) })));
  if (!final.report.ok || signature(final.sources) !== signature(audit.sources)) {
    return { deleted: [], preservedPasswords, backupUrl: backup.url, report: final.report, reason: 'O histórico mudou durante a conferência; nenhum canal foi excluído.' };
  }
  const deleted = [];
  const parentIds = new Set(final.sources.map(source => source.channel.parentId).filter(Boolean));
  const currentIds = new Set(Object.values(await store.getConfig(guild.id, 'channels', {})));
  const currentCategories = new Set(Object.values(await store.getConfig(guild.id, 'categories', {})));
  for (const { channel } of final.sources) {
    if (currentIds.has(channel.id) || channel.id === store.channel.id) throw new Error('Um canal atual foi selecionado; exclusão interrompida.');
    await channel.delete('Histórico antigo conferido e preservado em backup criptografado.');
    deleted.push({ id: channel.id, name: channel.name });
    progress(`Canal antigo removido: ${channel.name}.`);
  }
  await guild.channels.fetch();
  for (const id of parentIds) {
    const category = guild.channels.cache.get(id);
    if (!category || category.type !== ChannelType.GuildCategory || currentCategories.has(id) ||
        !['📁 UNLOCK FÁCIL', '📁・CONTAS LIVRES'].includes(category.name)) continue;
    if ([...guild.channels.cache.values()].some(channel => channel.parentId === id)) continue;
    await category.delete('Categoria antiga vazia após a remoção conferida.');
    deleted.push({ id: category.id, name: category.name });
  }
  return { deleted, preservedPasswords, backupUrl: backup.url, report: final.report };
}

module.exports = { cleanupLegacy, hasBlockingDifferences };

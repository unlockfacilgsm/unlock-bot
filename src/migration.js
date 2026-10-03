'use strict';

const { ChannelType } = require('discord.js');
const { fetchAllMessages, CHANNEL_NAMES } = require('./transport');

const TYPES = { VEN: 'vendas', VENC: 'vencimentos', REN: 'renovacoes', TRC: 'trocas' };
const LEGACY_PLANS = new Set(['12 horas', '3 dias', '1 mês', '3 meses', '12 meses']);
const LABELS = new Set(['ID', 'VENDA ID', 'CLIENTE', 'FERRAMENTA', 'PLANO', 'NOVO PLANO', 'LOGIN', 'SENHA', 'VENCIMENTO', 'NOVO VENCIMENTO', 'REGISTRADO EM', 'VENDA', 'STATUS', 'MOTIVO', 'OBSERVAÇÃO']);

function parseLegacyDate(value, fallback) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?$/);
  if (!match) return fallback ? new Date(fallback).toISOString() : null;
  const [, day, month, year, hour = '00', minute = '00'] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00-03:00`);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  if (get('day') !== day || get('month') !== month || get('year') !== year || get('hour') !== hour || get('minute') !== minute) return null;
  return date.toISOString();
}

function unquote(value) {
  if (value?.startsWith('`') && value.endsWith('`')) return value.slice(1, -1);
  return value;
}

/** Accept only the old bot's exact labeled record format, not arbitrary chat. */
function parseLegacyRecord(message, catalog, now = new Date()) {
  if (!message?.content || /\bUF4:/.test(message.content)) return null;
  const fields = {};
  for (const line of message.content.split('\n')) {
    const clean = line.replace(/^[^\p{L}\p{N}]*/u, '');
    const colon = clean.indexOf(':');
    if (colon < 0) continue;
    const label = clean.slice(0, colon).trim();
    if (!LABELS.has(label)) continue;
    if (Object.hasOwn(fields, label)) throw new Error(`Campo duplicado ${label}; requer revisão manual.`);
    fields[label] = clean.slice(colon + 1).replace(/^ /, '');
  }
  const id = fields.ID?.trim();
  const prefix = id?.match(/^(VEN|VENC|REN|TRC)-\d+$/)?.[1];
  if (!prefix) return null;
  const type = TYPES[prefix];
  const tool = fields.FERRAMENTA?.trim();
  if (!catalog[tool]) throw new Error(`Ferramenta desconhecida no registro ${id}.`);
  if (!fields.CLIENTE?.trim()) throw new Error(`Cliente ausente no registro ${id}.`);
  const registeredAt = parseLegacyDate(fields['REGISTRADO EM'], message.createdTimestamp || message.createdAt);
  if (!registeredAt) throw new Error(`Data inválida no registro ${id}.`);
  const plan = (fields['NOVO PLANO'] || fields.PLANO)?.trim();
  const spec = catalog[tool].plans[plan];
  const expiresAt = parseLegacyDate(fields['NOVO VENCIMENTO'] || fields.VENCIMENTO);
  if (['vendas', 'renovacoes'].includes(type) && (!LEGACY_PLANS.has(plan) || !expiresAt)) throw new Error(`Plano ou vencimento inválido no registro ${id}.`);
  if (type === 'vencimentos' && !expiresAt) throw new Error(`Vencimento inválido no registro ${id}.`);
  const record = {
    id, type, tool, client: fields.CLIENTE, registeredAt,
    legacyId: id, legacyMessageId: message.id, legacyChannelId: message.channelId,
    legacyUrl: message.url, migrationImported: true,
    ...(plan ? { plan, currentPlan: plan } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(fields.LOGIN != null ? { login: unquote(fields.LOGIN) } : {}),
    ...(fields.SENHA != null ? { password: unquote(fields.SENHA) } : {}),
    ...(fields.MOTIVO ? { reason: fields.MOTIVO } : {}),
    ...(fields.OBSERVAÇÃO ? { observation: fields.OBSERVAÇÃO } : {}),
    ...(fields['VENDA ID'] ? { saleId: fields['VENDA ID'].trim() } : {}),
    ...(fields.VENDA ? { legacySaleUrl: fields.VENDA.trim() } : {}),
    migrationPasswordChanged: fields.STATUS?.trim() === 'SENHA TROCADA'
  };
  if (type === 'vendas') {
    if (record.login == null || record.password == null || !record.login) throw new Error(`Credenciais ausentes no registro ${id}.`);
    record.status = +new Date(expiresAt) > +new Date(now) ? 'active' : 'expired';
  } else if (type === 'vencimentos') record.status = 'pending';
  if (type === 'vendas' || type === 'renovacoes') {
    record.priceCents = typeof spec === 'number' ? Math.round(spec * 100) : spec?.priceCents ?? 0;
    record.priceUnknown = !spec;
    record.discountCents = 0;
    record.priceEstimated = true;
    record.migrationPriceNote = 'Valor inferido da tabela atual; o bot antigo não guardava o valor cobrado. O plano original de vendas renovadas pode ter sido sobrescrito.';
  }
  return record;
}

function parseFreeCredentials(message, tool) {
  if (!message.content || /\bUF4:/.test(message.content)) return [];
  const result = [];
  for (const line of message.content.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0 || colon === line.length - 1) continue;
    const login = line.slice(0, colon);
    if (login.trim() !== login || /[\s`]/.test(login)) continue;
    result.push({ tool, login, password: line.slice(colon + 1), registeredAt: new Date(message.createdTimestamp || message.createdAt).toISOString(), legacyMessageId: message.id, legacyChannelId: message.channelId });
  }
  return result;
}

async function migrateLegacy(guild, { client, store, transport, catalog, clock = () => new Date() }) {
  catalog = catalog?.TOOLS || catalog;
  const now = new Date(clock());
  const botId = client.user.id;
  const mapping = await store.getConfig(guild.id, 'channels', {});
  const currentIds = new Set(Object.values(mapping));
  const names = new Set([
    ...['vendas', 'vencimentos', 'trocas', 'renovacoes'].map(key => CHANNEL_NAMES[key]),
    ...Object.values(catalog).map(tool => tool.channelName), '🔐・trocas-de-senha', '🆓・contas-livres'
  ]);
  await guild.channels.fetch();
  const channels = [...guild.channels.cache.values()].filter(channel => channel.type === ChannelType.GuildText && !currentIds.has(channel.id) && names.has(channel.name.replace(/^arquivo-/, '')));
  const report = {
    channels: channels.length, imported: { vendas: 0, vencimentos: 0, renovacoes: 0, trocas: 0, contas: 0 },
    alreadyImported: 0, ignoredOtherAuthors: 0, duplicateIds: [], conflicts: [], errors: [], archived: [],
    notes: ['Os valores antigos são estimados pela tabela atual. Vendas antigas renovadas podem já ter perdido seu plano original. Senhas e registros antigos não são removidos.']
  };
  const records = [], credentials = [];
  for (const channel of channels) {
    const tool = Object.entries(catalog).find(([, spec]) => spec.channelName === channel.name.replace(/^arquivo-/, ''))?.[0];
    const messages = await fetchAllMessages(channel);
    for (const message of messages) {
      if (message.author?.id !== botId) { report.ignoredOtherAuthors++; continue; }
      try {
        const record = parseLegacyRecord(message, catalog, now);
        if (record) { records.push(record); continue; }
        if (tool) credentials.push(...parseFreeCredentials(message, tool));
      } catch (error) { report.errors.push({ channelId: channel.id, messageId: message.id, error: error.message }); }
    }
  }
  records.sort((a, b) => +new Date(a.registeredAt) - +new Date(b.registeredAt) || a.legacyMessageId.localeCompare(b.legacyMessageId));
  const sources = new Map(), ids = new Map(), ambiguousIds = new Set();
  for (const record of records) {
    const original = record.id;
    const key = `${record.type}:${original}`;
    const existing = await store.getRecord(guild.id, record.type, original);
    if (ids.has(key) || (existing && existing.legacyMessageId !== record.legacyMessageId)) {
      ambiguousIds.add(key);
      record.id = `${original.split('-')[0]}-LEGACY-${record.legacyMessageId}`;
      report.duplicateIds.push({ originalId: original, importedId: record.id, messageId: record.legacyMessageId });
    }
    if (!ids.has(key)) ids.set(key, record);
    if (record.legacyUrl) sources.set(record.legacyUrl, record);
    sources.set(record.legacyMessageId, record);
  }
  const sales = records.filter(record => record.type === 'vendas');
  const freeByAccount = new Map();
  const keyFor = (tool, login) => `${tool}\u0000${login}`;
  for (const credential of credentials.sort((a, b) => +new Date(a.registeredAt) - +new Date(b.registeredAt))) freeByAccount.set(keyFor(credential.tool, credential.login), credential);
  for (const record of records) {
    if (!['vencimentos', 'renovacoes'].includes(record.type)) continue;
    const sale = sources.get(record.legacySaleUrl) || (record.saleId && !ambiguousIds.has(`vendas:${record.saleId}`) ? ids.get(`vendas:${record.saleId}`) : null);
    if (!sale || sale.type !== 'vendas') {
      report.errors.push({ messageId: record.legacyMessageId, error: `A venda original de ${record.id} não foi localizada com segurança.` });
      record.migrationOrphan = true;
    } else {
      record.saleId = sale.id;
      record.login = sale.login;
    }
  }
  for (const sale of sales) {
    const expirations = records.filter(record => record.type === 'vencimentos' && record.saleId === sale.id);
    const changed = sale.migrationPasswordChanged || expirations.some(record => record.migrationPasswordChanged && record.expiresAt >= sale.expiresAt);
    const free = freeByAccount.get(keyFor(sale.tool, sale.login));
    const published = free && free.registeredAt >= sale.registeredAt && +new Date(free.registeredAt) >= +new Date(sale.expiresAt);
    if (changed && published) {
      sale.status = 'released';
      sale.password = free.password;
      for (const expiration of expirations) if (expiration.expiresAt <= sale.expiresAt) expiration.status = 'released';
    } else if (changed) {
      sale.migrationReleaseUnverified = true;
      if (+new Date(sale.expiresAt) <= +now) sale.status = 'expired';
      report.notes.push(`A liberação de ${sale.id} não tem confirmação de publicação das credenciais; a conta permanece ocupada até revisão.`);
    }
  }
  const occupied = new Map();
  for (const sale of sales.filter(sale => sale.status !== 'released')) {
    const key = keyFor(sale.tool, sale.login);
    if (occupied.has(key)) {
      const older = occupied.get(key);
      older.migrationConflict = true; sale.migrationConflict = true;
      report.conflicts.push({ tool: sale.tool, login: sale.login, saleIds: [older.id, sale.id] });
    }
    occupied.set(key, sale);
  }
  for (const record of records) {
    try {
      const already = await store.getRecord(guild.id, record.type, record.id);
      if (already?.legacyMessageId === record.legacyMessageId) { report.alreadyImported++; continue; }
      await store.saveImportedRecord(guild.id, record.type, record);
      const saved = await store.getRecord(guild.id, record.type, record.id);
      if (!saved || saved.legacyMessageId !== record.legacyMessageId) throw new Error('A importação não foi confirmada no histórico persistente.');
      report.imported[record.type]++;
    } catch (error) { report.errors.push({ messageId: record.legacyMessageId, error: error.message }); }
  }
  for (const credential of freeByAccount.values()) {
    // A historical free publication must never replace an occupied account.
    if (occupied.has(keyFor(credential.tool, credential.login))) continue;
    try {
      await store.saveImportedAccount(guild.id, { ...credential, status: 'available', activeSaleId: null, migrationImported: true });
      report.imported.contas++;
    } catch (error) { report.errors.push({ messageId: credential.legacyMessageId, error: error.message }); }
  }
  if (report.errors.length === 0) {
    for (const channel of channels) {
      try { await transport.archiveLegacy(guild, channel); report.archived.push(channel.id); }
      catch (error) { report.errors.push({ channelId: channel.id, error: `Falha ao arquivar: ${error.message}` }); }
    }
  }
  // Keep a credential-free migration result available for subsequent reviews.
  await store.setConfig(guild.id, 'lastMigration', { ...report, completedAt: now.toISOString() });
  return report;
}

module.exports = { migrateLegacy, parseLegacyRecord, parseLegacyDate, parseFreeCredentials };

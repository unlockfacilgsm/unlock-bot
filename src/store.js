'use strict';

const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { normalizeEncryptionKey, encryptString, decryptString } = require('./crypto');
const { calculateExpiration } = require('./dates');
const { TOOLS, getPlan } = require('./catalog');
const { password: validatePassword } = require('./validation');

const TYPES = Object.freeze({ vendas: 'VEN', vencimentos: 'VENC', renovacoes: 'REN', trocas: 'TRC' });
const ALIASES = Object.freeze({
  sale: 'vendas', sales: 'vendas', venda: 'vendas', VEN: 'vendas',
  expiration: 'vencimentos', expirations: 'vencimentos', vencimento: 'vencimentos', VENC: 'vencimentos',
  renewal: 'renovacoes', renewals: 'renovacoes', renovacao: 'renovacoes', REN: 'renovacoes',
  trade: 'trocas', trades: 'trocas', troca: 'trocas', TRC: 'trocas',
});
const EVENT_FORMAT = 'unlock-bot-event-v1';
const SNAPSHOT_FORMAT = 'unlock-bot-snapshot-v1';
const channelLocks = new Map();
const context = new AsyncLocalStorage();

function typeName(type) {
  const normalized = ALIASES[type] || type;
  if (!TYPES[normalized]) throw new Error(`Tipo de registro inválido: ${type}.`);
  return normalized;
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|senha|newPassword|new_password|passwordEncrypted|encryptionKey)$/i.test(key)) continue;
      if (item !== undefined) result[key] = clean(item);
    }
    return result;
  }
  return value;
}

function isoDate(value, fallback = new Date()) {
  const date = value === undefined || value === null ? fallback : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return date.toISOString();
}

function requiredText(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} inválido; use de 1 a ${max} caracteres em uma linha.`);
  }
  return value;
}

function cents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} deve ser um valor inteiro não negativo em centavos.`);
  return value;
}

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Object.values(collection);
}

function emptyState(guildId) {
  return {
    version: 1, guildId, records: { vendas: {}, vencimentos: {}, renovacoes: {}, trocas: {} },
    accounts: {}, counters: {}, config: {}, outbox: {}, audit: [],
  };
}

function sortMessages(a, b) {
  if (/^\d+$/.test(String(a.id)) && /^\d+$/.test(String(b.id))) {
    return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  }
  return (a.createdTimestamp || 0) - (b.createdTimestamp || 0) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

class Store {
  constructor({ channel, encryptionKey, guildId, botId, downloadAttachment, clock = () => new Date() } = {}) {
    if (!channel || typeof channel.send !== 'function' || !channel.messages?.fetch) {
      throw new Error('Informe o canal privado de dados do Discord.');
    }
    this.channel = channel;
    this.guildId = String(guildId || channel.guildId || channel.guild?.id || '');
    if (!this.guildId) throw new Error('Servidor inválido.');
    this.botId = String(botId || channel.client?.user?.id || '');
    if (!this.botId) throw new Error('Não foi possível identificar o usuário do bot.');
    this.key = normalizeEncryptionKey(encryptionKey);
    this.clock = clock;
    this.downloadAttachment = downloadAttachment || (async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Falha ao ler anexo de dados (${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    });
    this._state = emptyState(this.guildId);
    this._sequence = 0;
    this._lastEventId = null;
    this._headMessageId = null;
    this._latestMessageId = null;
    this._loaded = false;
    this._lastCheckpointSequence = 0;
    this._lockKey = `${this.guildId}:${channel.id || 'data-channel'}`;
  }

  _guild(guildId) {
    if (String(guildId) !== this.guildId) throw new Error('Registro pertence a outro servidor.');
  }

  _current() {
    const tx = context.getStore();
    return tx?.store === this ? tx.draft : this._state;
  }

  async _serialized(fn) {
    const previous = channelLocks.get(this._lockKey) || Promise.resolve();
    const running = previous.catch(() => {}).then(fn);
    channelLocks.set(this._lockKey, running);
    try { return await running; }
    finally { if (channelLocks.get(this._lockKey) === running) channelLocks.delete(this._lockKey); }
  }

  async load() {
    return this._serialized(() => this._load());
  }

  async _load() {
    let messages = [];
    let snapshotMessage = null;
    let before;
    const seen = new Set();
    for (;;) {
      const page = values(await this.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }));
      if (!page.length) break;
      const fresh = page.filter((message) => !seen.has(String(message.id)));
      if (!fresh.length) throw new Error('O Discord repetiu uma página do histórico de dados.');
      for (const message of fresh) { messages.push(message); seen.add(String(message.id)); }
      const snapshots = fresh.filter((message) => String(message.author?.id) === this.botId &&
        values(message.attachments).some((attachment) => attachment.name === 'unlock-snapshot.json')).sort(sortMessages);
      if (snapshots.length) { snapshotMessage = snapshots.at(-1); break; }
      before = String(page.slice().sort(sortMessages)[0].id);
      if (page.length < 100) break;
    }
    if (snapshotMessage) messages = messages.filter((message) => sortMessages(message, snapshotMessage) >= 0);
    messages.sort(sortMessages);
    let state = emptyState(this.guildId);
    let sequence = 0;
    let lastEventId = null;
    let headMessageId = null;
    const events = new Set();
    let snapshotSequence = 0;
    for (const message of messages) {
      if (String(message.author?.id) !== this.botId) continue;
      for (const attachment of values(message.attachments)) {
        if (!['unlock-event.json', 'unlock-snapshot.json'].includes(attachment.name)) continue;
        const downloaded = await this.downloadAttachment(attachment.url, attachment);
        let entry;
        try { entry = JSON.parse(Buffer.from(downloaded).toString('utf8')); }
        catch { throw new Error(`Anexo de dados inválido na mensagem ${message.id}.`); }
        if (entry.guildId !== this.guildId) throw new Error('Anexo de dados pertence a outro servidor.');
        if (entry.format === SNAPSHOT_FORMAT) {
          if (!entry.encrypted) throw new Error('Snapshot sem criptografia não é aceito.');
          const restored = JSON.parse(decryptString(entry.data, this.key, `snapshot:${this.guildId}`));
          if (restored.sequence < sequence) continue;
          this._validateSnapshot(restored);
          state = restored.state;
          sequence = restored.sequence;
          snapshotSequence = restored.sequence;
          lastEventId = restored.lastEventId;
          headMessageId = String(message.id);
          continue;
        }
        if (entry.format !== EVENT_FORMAT) throw new Error('Formato de evento incompatível.');
        this._verifyEvent(entry);
        if (events.has(entry.eventId)) continue;
        events.add(entry.eventId);
        if (entry.sequence <= snapshotSequence) continue;
        if (entry.sequence !== sequence + 1 || entry.previousEventId !== lastEventId) {
          throw new Error('Histórico de dados possui um evento ausente ou conflito. Nenhuma alteração foi aplicada.');
        }
        this._apply(state, entry.changes);
        sequence = entry.sequence;
        lastEventId = entry.eventId;
        headMessageId = String(message.id);
      }
    }
    for (const account of Object.values(state.accounts)) this._password(account);
    this._state = state;
    this._sequence = sequence;
    this._lastEventId = lastEventId;
    this._headMessageId = headMessageId;
    this._latestMessageId = messages.length ? String(messages.at(-1).id) : null;
    this._loaded = true;
    this._lastCheckpointSequence = snapshotSequence;
    return this;
  }

  _signEvent(event) {
    const { signature, ...unsigned } = event;
    return createHmac('sha256', this.key).update(JSON.stringify(unsigned)).digest('hex');
  }

  _verifyEvent(event) {
    const expected = Buffer.from(this._signEvent(event), 'hex');
    const supplied = /^[a-f0-9]{64}$/.test(event.signature || '') ? Buffer.from(event.signature, 'hex') : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error('Evento de dados sem autenticação válida. Verifique a chave e a integridade do histórico.');
    }
  }

  _apply(state, changes) {
    for (const [type, records] of Object.entries(changes.records || {})) {
      typeName(type);
      for (const record of records) state.records[type][record.id] = record;
    }
    for (const account of changes.accounts || []) state.accounts[account.id] = account;
    for (const entry of changes.outbox || []) state.outbox[entry.id] = entry;
    Object.assign(state.counters, changes.counters || {});
    Object.assign(state.config, changes.config || {});
    state.audit.push(...(changes.audit || []));
  }

  _changes(before, after) {
    const changed = (a, b) => Object.values(b).filter((item) => JSON.stringify(item) !== JSON.stringify(a[item.id]));
    const records = {};
    for (const type of Object.keys(TYPES)) {
      const entries = changed(before.records[type], after.records[type]);
      if (entries.length) records[type] = entries;
    }
    const mapDiff = (a, b) => Object.fromEntries(Object.entries(b).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(a[key])));
    return {
      records, accounts: changed(before.accounts, after.accounts), outbox: changed(before.outbox, after.outbox),
      counters: mapDiff(before.counters, after.counters), config: mapDiff(before.config, after.config),
      audit: after.audit.slice(before.audit.length),
    };
  }

  async _refresh() {
    if (!this._loaded) return this._load();
    const latest = values(await this.channel.messages.fetch({ limit: 1 })).sort(sortMessages).at(-1);
    if ((latest ? String(latest.id) : null) !== this._latestMessageId) await this._load();
  }

  async _ready() {
    if (!this._loaded && context.getStore()?.store !== this) await this.load();
  }

  async _mutate(fn) {
    const tx = context.getStore();
    if (tx?.store === this) return fn(tx.draft);
    return this._serialized(async () => {
      await this._refresh();
      const draft = structuredClone(this._state);
      const result = await context.run({ store: this, draft }, () => fn(draft));
      const changes = this._changes(this._state, draft);
      if (!Object.values(changes).some((part) => Array.isArray(part) ? part.length : Object.keys(part).length)) return structuredClone(result);
      const event = {
        format: EVENT_FORMAT, guildId: this.guildId, eventId: randomUUID(), sequence: this._sequence + 1,
        previousEventId: this._lastEventId, createdAt: new Date().toISOString(), changes,
      };
      event.signature = this._signEvent(event);
      const nonce = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
      let message;
      try {
        message = await this.channel.send({
          content: `UF4 EVENT ${event.sequence} ${event.eventId}`, nonce, enforceNonce: true,
          files: [{ attachment: Buffer.from(JSON.stringify(event)), name: 'unlock-event.json' }],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        // A send may have reached Discord even when the response was lost.
        try {
          await this._load();
          if (this._lastEventId === event.eventId) return structuredClone(result);
        } catch (recoveryError) {
          throw new Error(`Falha ao confirmar gravação no Discord: ${recoveryError.message}`, { cause: error });
        }
        throw new Error('O Discord não confirmou a gravação. A operação pode ser repetida com segurança.', { cause: error });
      }
      this._state = draft;
      this._sequence = event.sequence;
      this._lastEventId = event.eventId;
      this._headMessageId = String(message.id);
      this._latestMessageId = String(message.id);
      return structuredClone(result);
    });
  }

  async transaction(fn) {
    if (typeof fn !== 'function') throw new Error('Transação inválida.');
    return this._mutate(() => fn(this));
  }

  _next(state, prefix) {
    const number = (state.counters[prefix] || 0) + 1;
    state.counters[prefix] = number;
    return `${prefix}-${String(number).padStart(3, '0')}`;
  }

  _advance(state, prefix, id) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (!match && new RegExp(`^${prefix}-LEGACY-[A-Za-z0-9_-]{1,64}$`).test(id)) return;
    if (!match) throw new Error(`ID inválido: ${id}.`);
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) throw new Error('ID excede o limite seguro do contador.');
    state.counters[prefix] = Math.max(state.counters[prefix] || 0, number);
  }

  _audit(state, action, entity, actorId, registeredAt, details = {}) {
    state.audit.push({ id: randomUUID(), guildId: this.guildId, action, entity, actorId: actorId || null,
      registeredAt: isoDate(registeredAt), ...clean(details) });
  }

  _queue(state, kind, payload, dedupeKey) {
    if (!dedupeKey) throw new Error('A entrega precisa de uma chave de idempotência.');
    const existing = Object.values(state.outbox).find((entry) => entry.dedupeKey === dedupeKey);
    if (existing) return existing;
    const entry = { id: randomUUID(), guildId: this.guildId, kind, payload: clean(payload), dedupeKey,
      status: 'pending', attempts: 0, registeredAt: new Date().toISOString(), lastError: null };
    state.outbox[entry.id] = entry;
    return entry;
  }

  _publish(state, type, record) {
    record.revision = (record.revision || 0) + 1;
    return this._queue(state, 'record', { type, id: record.id }, `record:${type}:${record.id}:${record.revision}`);
  }

  _publishAccount(state, account) {
    account.revision = (account.revision || 0) + 1;
    return this._queue(state, 'account', { accountId: account.id }, `account:${account.id}:${account.revision}`);
  }

  _password(account) {
    return decryptString(account.passwordEncrypted, this.key, `account:${this.guildId}:${account.id}`);
  }

  _publicAccount(account) {
    if (!account) return null;
    const { passwordEncrypted, ...safe } = account;
    return { ...structuredClone(safe), password: this._password(account) };
  }

  _publicRecord(record) {
    return record ? clean(structuredClone(record)) : null;
  }

  _salePassword(state, sale) {
    if (!sale) return undefined;
    // This immutable credential belongs to this sale, including after release or account reuse.
    if (sale.passwordEncrypted) return decryptString(sale.passwordEncrypted, this.key, `sale:${this.guildId}:${sale.id}`);
    // Older events did not preserve a sale credential. Only a currently assigned, matching account is safe.
    const account = state.accounts[sale.accountId];
    if (!sale.migrationConflict && ['active', 'expired'].includes(sale.status) && account?.status === 'occupied' &&
        account.activeSaleId === sale.id && account.tool === sale.tool && account.login === sale.login) {
      return this._password(account);
    }
    return undefined;
  }

  _findAccount(state, tool, login) {
    return Object.values(state.accounts).find((account) => account.tool === tool && account.login === login);
  }

  _hasPending(state, accountId) {
    return Object.values(state.outbox).some((entry) => entry.kind === 'free-account' && entry.status !== 'delivered' && entry.payload.accountId === accountId);
  }

  _upsertAccount(state, data, { importing = false } = {}) {
    const tool = requiredText(data.tool, 'Ferramenta', 100);
    if (!Object.hasOwn(TOOLS, tool)) throw new Error('Ferramenta inválida.');
    const login = requiredText(data.login, 'Login', 500);
    const password = validatePassword(data.password);
    let account = this._findAccount(state, tool, login);
    if (account) {
      if (account.status === 'occupied' || account.pendingDelivery || this._hasPending(state, account.id)) {
        if (importing) return account;
        if (this._password(account) !== password || (data.status && data.status !== account.status)) {
          throw new Error('A conta está ocupada ou possui uma entrega pendente; suas credenciais não podem ser substituídas.');
        }
        return account;
      }
      if (importing && data.registeredAt && account.updatedAt > isoDate(data.registeredAt)) return account;
      const unchanged = this._password(account) === password && (!data.status || data.status === account.status);
      if (!unchanged) account.passwordEncrypted = encryptString(password, this.key, `account:${this.guildId}:${account.id}`);
      account.status = data.status || account.status;
      if (!importing || !unchanged) account.updatedAt = isoDate(data.registeredAt);
    } else {
      const id = data.id || this._next(state, 'ACC');
      this._advance(state, 'ACC', id);
      if (state.accounts[id]) throw new Error('ID de conta já está em uso.');
      account = { id, guildId: this.guildId, tool, login, status: data.status || 'available', activeSaleId: null,
        pendingDelivery: false, registeredAt: isoDate(data.registeredAt), updatedAt: isoDate(data.registeredAt),
        passwordEncrypted: encryptString(password, this.key, `account:${this.guildId}:${id}`) };
      state.accounts[id] = account;
    }
    for (const key of ['freeMessageId', 'freeChannelId', 'messageId', 'channelId', 'legacyMessageId', 'legacyChannelId']) {
      if (data[key]) account[key] = String(data[key]);
    }
    if (!['available', 'occupied'].includes(account.status)) throw new Error('Status da conta inválido.');
    return account;
  }

  async getConfig(guildId, key, fallback = null) {
    this._guild(guildId); await this._ready();
    return structuredClone(Object.hasOwn(this._current().config, key) ? this._current().config[key] : fallback);
  }

  async setConfig(guildId, key, value, { actorId } = {}) {
    this._guild(guildId);
    return this._mutate((state) => {
      if (!key || typeof key !== 'string') throw new Error('Chave de configuração inválida.');
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Chave de configuração inválida.');
      state.config[key] = clean(value);
      this._audit(state, 'config.updated', key, actorId);
      return state.config[key];
    });
  }

  async getRecord(guildId, type, id) {
    this._guild(guildId); await this._ready();
    return this._publicRecord(this._current().records[typeName(type)][id]);
  }

  /** Explicit private display API. Reports, exports and audit use the normal getters without credentials. */
  async getDisplayRecord(guildId, type, id) {
    this._guild(guildId); await this._ready();
    type = typeName(type);
    const state = this._current();
    const raw = state.records[type][id];
    if (!raw) return null;
    const record = this._publicRecord(raw);
    const sale = type === 'vendas' ? raw : ['vencimentos', 'renovacoes'].includes(type) ? state.records.vendas[raw.saleId] : null;
    const relatedMatches = type === 'vendas' || (sale && raw.tool === sale.tool && (!raw.login || raw.login === sale.login));
    if (relatedMatches) {
      const password = this._salePassword(state, sale);
      if (password !== undefined) record.password = password;
    }
    return record;
  }

  async preserveLegacySalePassword(guildId, { saleId, source, actorId } = {}) {
    this._guild(guildId);
    validatePassword(source?.password);
    return this._mutate(state => {
      const sale = state.records.vendas[saleId];
      if (!sale || sale.legacyMessageId !== source.legacyMessageId || sale.legacyChannelId !== source.legacyChannelId) {
        throw new Error('A fonte antiga não corresponde à venda selecionada.');
      }
      const fields = ['client', 'tool', 'login', 'registeredAt', 'expiresAt'];
      if (fields.some(field => sale[field] !== source[field]) || (sale.currentPlan || sale.plan) !== source.plan) {
        throw new Error('Os dados da venda mudaram; confira a comparação antes de preservar a senha antiga.');
      }
      if (sale.passwordEncrypted) {
        if (decryptString(sale.passwordEncrypted, this.key, `sale:${this.guildId}:${sale.id}`) !== source.password) {
          throw new Error('A venda já possui uma senha histórica diferente; nenhuma substituição foi feita.');
        }
        return this._publicRecord(sale);
      }
      sale.passwordEncrypted = encryptString(source.password, this.key, `sale:${this.guildId}:${sale.id}`);
      this._audit(state, 'sale.legacy-password-preserved', sale.id, actorId);
      return this._publicRecord(sale);
    });
  }

  async getRecordByMessage(guildId, messageId) {
    this._guild(guildId); await this._ready();
    for (const records of Object.values(this._current().records)) {
      const found = Object.values(records).find((record) => record.messageId === String(messageId));
      if (found) return this._publicRecord(found);
    }
    return null;
  }

  async listRecords(guildId, type, { query, limit, offset = 0 } = {}) {
    this._guild(guildId); await this._ready();
    let records = Object.values(this._current().records[typeName(type)]).map(record => this._publicRecord(record));
    if (query) {
      const term = String(query).toLocaleLowerCase('pt-BR');
      records = records.filter((record) => JSON.stringify(record).toLocaleLowerCase('pt-BR').includes(term));
    }
    records.sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    return structuredClone(records.slice(Math.max(0, offset), limit === undefined ? undefined : Math.max(0, offset) + Math.max(0, limit)));
  }

  async setRecordMessage(guildId, type, id, { messageId, channelId }) {
    this._guild(guildId); type = typeName(type);
    return this._mutate((state) => {
      const record = state.records[type][id];
      if (!record) throw new Error('Registro não encontrado.');
      record.messageId = String(messageId);
      record.channelId = String(channelId);
      return this._publicRecord(record);
    });
  }

  async saveImportedRecord(guildId, type, imported) {
    this._guild(guildId); type = typeName(type);
    return this._mutate((state) => {
      const existing = state.records[type][imported.id];
      if (existing) return this._publicRecord(existing);
      this._advance(state, TYPES[type], imported.id);
      if (imported.legacyId && new RegExp(`^${TYPES[type]}-\\d+$`).test(imported.legacyId)) this._advance(state, TYPES[type], imported.legacyId);
      const record = { ...clean(imported), id: imported.id, type, guildId: this.guildId,
        registeredAt: isoDate(imported.registeredAt), revision: 0 };
      if (record.expiresAt) record.expiresAt = isoDate(record.expiresAt);
      if (type === 'vendas') {
        if (imported.password !== undefined && imported.password !== null) {
          record.passwordEncrypted = encryptString(validatePassword(imported.password), this.key, `sale:${this.guildId}:${record.id}`);
        }
        record.currentPlan = record.currentPlan || record.plan;
        record.status = record.status || (new Date(record.expiresAt) <= new Date() ? 'expired' : 'active');
        record.priceCents = cents(record.priceCents ?? 0, 'Preço');
        record.discountCents = cents(record.discountCents ?? 0, 'Desconto');
        let account = record.accountId && state.accounts[record.accountId];
        account ||= record.login && this._findAccount(state, record.tool, record.login);
        if (!account && imported.password) account = this._upsertAccount(state, { ...imported, status: 'available', id: undefined }, { importing: true });
        if (account) {
          record.accountId = account.id;
          if (record.status !== 'released') {
            const assigned = state.records.vendas[account.activeSaleId];
            if (!assigned || new Date(assigned.registeredAt) <= new Date(record.registeredAt)) {
              account.activeSaleId = record.id;
              account.status = 'occupied';
              if (imported.password) account.passwordEncrypted = encryptString(imported.password, this.key, `account:${this.guildId}:${account.id}`);
            }
          }
        }
      }
      state.records[type][record.id] = record;
      if ((type === 'vendas' && record.status !== 'released') || (type === 'vencimentos' && record.status === 'pending')) {
        this._publish(state, type, record);
        if (type === 'vendas' && record.accountId) this._publishAccount(state, state.accounts[record.accountId]);
      }
      this._audit(state, 'record.imported', record.id, imported.actorId, record.registeredAt, { type });
      return this._publicRecord(record);
    });
  }

  async saveImportedAccount(guildId, data) {
    this._guild(guildId);
    return this._mutate((state) => {
      const before = JSON.stringify({ accounts: state.accounts, records: state.records.vendas });
      const account = this._upsertAccount(state, data, { importing: true });
      const matchingSales = Object.values(state.records.vendas).filter((sale) => sale.tool === account.tool && sale.login === account.login);
      for (const sale of matchingSales) sale.accountId = account.id;
      const assigned = matchingSales.filter((sale) => sale.status !== 'released')
        .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt) ||
          Number(b.id === account.activeSaleId) - Number(a.id === account.activeSaleId) ||
          b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
      if (assigned) { account.status = 'occupied'; account.activeSaleId = assigned.id; }
      if (before !== JSON.stringify({ accounts: state.accounts, records: state.records.vendas })) {
        this._publishAccount(state, account);
        this._audit(state, 'account.imported', account.id, data.actorId, data.registeredAt);
      }
      return this._publicAccount(account);
    });
  }

  async getAccount(guildId, id) {
    this._guild(guildId); await this._ready();
    return this._publicAccount(this._current().accounts[id]);
  }

  async listAccounts(guildId, { tool, status, query } = {}) {
    this._guild(guildId); await this._ready();
    const term = query && String(query).toLocaleLowerCase('pt-BR');
    return Object.values(this._current().accounts).filter((account) =>
      (!tool || account.tool === tool) && (!status || account.status === status) &&
      (!term || `${account.id} ${account.tool} ${account.login}`.toLocaleLowerCase('pt-BR').includes(term)))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((account) => this._publicAccount(account));
  }

  async upsertAccount(guildId, data) {
    this._guild(guildId);
    return this._mutate((state) => {
      const account = this._upsertAccount(state, data);
      this._publishAccount(state, account);
      this._audit(state, 'account.saved', account.id, data.actorId, data.registeredAt);
      return this._publicAccount(account);
    });
  }

  async createSale(guildId, data) {
    this._guild(guildId);
    return this._mutate((state) => {
      requiredText(data.client, 'Cliente', 500);
      requiredText(data.tool, 'Ferramenta', 100);
      requiredText(data.plan, 'Plano', 100);
      getPlan(data.tool, data.plan);
      const priceCents = cents(data.priceCents, 'Preço');
      const discountCents = cents(data.discountCents ?? 0, 'Desconto');
      let account = data.accountId ? state.accounts[data.accountId] : this._findAccount(state, data.tool, data.login);
      if (data.accountId && !account) throw new Error('Conta não encontrada.');
      if (!account) account = this._upsertAccount(state, data);
      if (account.tool !== data.tool) throw new Error('A conta pertence a outra ferramenta.');
      if (account.status !== 'available' || account.activeSaleId) throw new Error('A conta já está ocupada.');
      if (account.pendingDelivery || this._hasPending(state, account.id)) throw new Error('A conta possui entrega pendente; aguarde a publicação confirmada.');
      if (data.password !== undefined && this._password(account) !== data.password) {
        throw new Error('A senha informada difere do estoque; atualize a conta antes da venda.');
      }
      const registeredAt = isoDate(data.registeredAt);
      const expiresAt = calculateExpiration(data.plan, new Date(registeredAt)).toISOString();
      const record = { id: this._next(state, 'VEN'), type: 'vendas', guildId: this.guildId, client: data.client,
        tool: data.tool, plan: data.plan, currentPlan: data.plan, accountId: account.id, login: account.login,
        priceCents, discountCents, priceEstimated: false, registeredAt, expiresAt,
        status: new Date(expiresAt) <= new Date() ? 'expired' : 'active', actorId: data.actorId || null };
      record.passwordEncrypted = encryptString(this._password(account), this.key, `sale:${this.guildId}:${record.id}`);
      state.records.vendas[record.id] = record;
      account.status = 'occupied'; account.activeSaleId = record.id; account.updatedAt = registeredAt;
      this._publish(state, 'vendas', record);
      this._publishAccount(state, account);
      this._audit(state, 'sale.created', record.id, data.actorId, registeredAt, { accountId: account.id, priceCents, discountCents });
      return this._publicRecord(record);
    });
  }

  async renewSale(guildId, data) {
    this._guild(guildId);
    return this._mutate((state) => {
      const sale = state.records.vendas[data.saleId];
      if (!sale) throw new Error('Venda não encontrada.');
      const account = state.accounts[sale.accountId];
      if (sale.status === 'released' || !account || account.activeSaleId !== sale.id) throw new Error('Esta venda já teve a conta liberada ou transferida.');
      const priceCents = cents(data.priceCents, 'Preço');
      const discountCents = cents(data.discountCents ?? 0, 'Desconto');
      getPlan(sale.tool, data.plan);
      const registeredAt = isoDate(data.registeredAt);
      const base = new Date(Math.max(new Date(registeredAt).getTime(), new Date(sale.expiresAt).getTime()));
      const expiresAt = calculateExpiration(data.plan, base).toISOString();
      sale.currentPlan = data.plan; sale.expiresAt = expiresAt; sale.status = 'active';
      const renewal = { id: this._next(state, 'REN'), type: 'renovacoes', guildId: this.guildId, saleId: sale.id,
        client: sale.client, tool: sale.tool, login: sale.login, plan: data.plan, priceCents, discountCents,
        registeredAt, expiresAt, actorId: data.actorId || null };
      state.records.renovacoes[renewal.id] = renewal;
      // Old reminders and expirations refer to the previous deadline and must never release this renewed account.
      for (const expiration of Object.values(state.records.vencimentos)) {
        if (expiration.saleId === sale.id && expiration.status === 'pending') {
          expiration.status = 'cancelled'; expiration.cancelledAt = registeredAt;
          this._publish(state, 'vencimentos', expiration);
        }
      }
      this._publish(state, 'vendas', sale); this._publish(state, 'renovacoes', renewal);
      this._audit(state, 'sale.renewed', renewal.id, data.actorId, registeredAt, { saleId: sale.id, priceCents, discountCents });
      return renewal;
    });
  }

  async expireSales(guildId, nowISO = new Date().toISOString()) {
    this._guild(guildId);
    return this._mutate((state) => {
      const now = isoDate(nowISO);
      const changed = [];
      for (const sale of Object.values(state.records.vendas)) {
        if (!['active', 'expired'].includes(sale.status) || sale.expiresAt > now) continue;
        const exists = Object.values(state.records.vencimentos).some((entry) => entry.saleId === sale.id && entry.expiresAt === sale.expiresAt && entry.status !== 'cancelled');
        if (exists) continue;
        sale.status = 'expired';
        const expiration = { id: this._next(state, 'VENC'), type: 'vencimentos', guildId: this.guildId,
          saleId: sale.id, client: sale.client, tool: sale.tool, login: sale.login, accountId: sale.accountId,
          expiresAt: sale.expiresAt, registeredAt: now, status: 'pending' };
        state.records.vencimentos[expiration.id] = expiration;
        this._publish(state, 'vendas', sale); this._publish(state, 'vencimentos', expiration);
        this._audit(state, 'sale.expired', expiration.id, null, now, { saleId: sale.id });
        changed.push(expiration);
      }
      return changed;
    });
  }

  _expirationAccount(state, id) {
    const expiration = state.records.vencimentos[id];
    if (!expiration) throw new Error('Vencimento não encontrado.');
    if (expiration.status === 'released') throw new Error('Vencimento já processado.');
    if (expiration.status !== 'pending') throw new Error('Vencimento cancelado ou inválido.');
    const sale = state.records.vendas[expiration.saleId];
    const account = sale && state.accounts[sale.accountId];
    if (!sale || !account) throw new Error('Venda ou conta vinculada não encontrada.');
    if (account.activeSaleId !== sale.id) throw new Error('A conta está vinculada a outra venda; este vencimento não pode liberá-la.');
    if (sale.expiresAt !== expiration.expiresAt || sale.status !== 'expired') throw new Error('A venda foi renovada ou ainda está ativa.');
    if (new Date(expiration.expiresAt).getTime() > new Date(this.clock()).getTime()) throw new Error('A conta ainda não atingiu o vencimento.');
    return { expiration, sale, account };
  }

  async releaseAccounts(guildId, { expirationIds, newPassword, actorId, registeredAt } = {}) {
    this._guild(guildId);
    validatePassword(newPassword);
    if (!Array.isArray(expirationIds) || !expirationIds.length) throw new Error('Informe pelo menos um vencimento.');
    const changed = [], errors = [];
    // One independently recoverable commit for each account in the batch.
    for (const id of expirationIds) {
      try {
        const result = await this._mutate((state) => {
          const { expiration, sale, account } = this._expirationAccount(state, id);
          const when = isoDate(registeredAt);
          account.passwordEncrypted = encryptString(newPassword, this.key, `account:${this.guildId}:${account.id}`);
          account.status = 'available'; account.activeSaleId = null; account.pendingDelivery = true;
          account.pendingExpirationId = expiration.id; account.updatedAt = when;
          expiration.status = 'released'; expiration.releasedAt = when; expiration.actorId = actorId || null;
          sale.status = 'released'; sale.releasedAt = when;
          this._publish(state, 'vendas', sale); this._publish(state, 'vencimentos', expiration);
          this._queue(state, 'free-account', { accountId: account.id, expirationId: expiration.id }, `free-account:${expiration.id}`);
          this._audit(state, 'account.released', account.id, actorId, when, { saleId: sale.id, expirationId: expiration.id });
          return expiration;
        });
        changed.push(result);
      } catch (error) { errors.push({ id, message: error.message }); }
    }
    return { changed, errors };
  }

  async updatePassword(guildId, { expirationId, newPassword, actorId } = {}) {
    this._guild(guildId); validatePassword(newPassword);
    return this._mutate((state) => {
      const { expiration, account } = this._expirationAccount(state, expirationId);
      account.passwordEncrypted = encryptString(newPassword, this.key, `account:${this.guildId}:${account.id}`);
      account.updatedAt = new Date().toISOString();
      expiration.passwordUpdatedAt = account.updatedAt; expiration.actorId = actorId || null;
      this._publish(state, 'vencimentos', expiration);
      this._audit(state, 'account.password-confirmed', account.id, actorId, account.updatedAt, { expirationId });
      return expiration;
    });
  }

  async updateAccountPassword(guildId, { accountId, newPassword, actorId } = {}) {
    this._guild(guildId); validatePassword(newPassword);
    return this._mutate((state) => {
      const account = state.accounts[accountId];
      if (!account) throw new Error('Conta não encontrada.');
      if (account.pendingDelivery || this._hasPending(state, account.id)) throw new Error('A conta possui entrega pendente; conclua a publicação antes de trocar sua senha.');
      account.passwordEncrypted = encryptString(newPassword, this.key, `account:${this.guildId}:${account.id}`);
      account.updatedAt = new Date().toISOString();
      this._publishAccount(state, account);
      this._audit(state, 'account.password-confirmed', account.id, actorId, account.updatedAt);
      return this._publicAccount(account);
    });
  }

  async setAccountMessage(guildId, id, { messageId, channelId }) {
    this._guild(guildId);
    return this._mutate((state) => {
      const account = state.accounts[id];
      if (!account) throw new Error('Conta não encontrada.');
      account.messageId = String(messageId); account.channelId = String(channelId);
      account.freeMessageId = String(messageId); account.freeChannelId = String(channelId);
      return this._publicAccount(account);
    });
  }

  async createTrade(guildId, data) {
    this._guild(guildId);
    return this._mutate((state) => {
      requiredText(data.client, 'Cliente', 500);
      if (!Object.hasOwn(TOOLS, data.tool)) throw new Error('Ferramenta inválida.');
      if (data.saleId) {
        const sale = state.records.vendas[data.saleId];
        if (!sale) throw new Error('Venda vinculada não encontrada.');
        if (sale.tool !== data.tool) throw new Error('A venda vinculada pertence a outra ferramenta.');
      }
      const record = { ...clean(data), id: this._next(state, 'TRC'), type: 'trocas', guildId: this.guildId,
        registeredAt: isoDate(data.registeredAt), actorId: data.actorId || null };
      state.records.trocas[record.id] = record;
      this._publish(state, 'trocas', record);
      this._audit(state, 'trade.created', record.id, data.actorId, record.registeredAt);
      return record;
    });
  }

  async queueOutbox(guildId, kind, payload, dedupeKey) {
    this._guild(guildId);
    return this._mutate((state) => this._queue(state, kind, payload, dedupeKey));
  }

  async enqueueOutbox(...args) { return this.queueOutbox(...args); }

  async listOutbox(guildId, { limit } = {}) {
    this._guild(guildId); await this._ready();
    const records = Object.values(this._current().outbox).filter((entry) => entry.status !== 'delivered')
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
    return structuredClone(limit === undefined ? records : records.slice(0, limit));
  }

  async completeOutbox(id, { messageId, channelId } = {}) {
    return this._mutate((state) => {
      const entry = state.outbox[id];
      if (!entry) throw new Error('Entrega não encontrada.');
      if (entry.status === 'delivered') return entry;
      entry.status = 'delivered'; entry.deliveredAt = new Date().toISOString(); entry.lastError = null;
      if (messageId) entry.messageId = String(messageId);
      if (channelId) entry.channelId = String(channelId);
      if (entry.kind === 'record') {
        const record = state.records[typeName(entry.payload.type)][entry.payload.id];
        if (record && messageId) { record.messageId = String(messageId); record.channelId = String(channelId); }
      } else if (entry.kind === 'free-account' || entry.kind === 'account') {
        const account = state.accounts[entry.payload.accountId];
        if (account && messageId) {
          account.messageId = String(messageId); account.channelId = String(channelId);
          account.freeMessageId = String(messageId); account.freeChannelId = String(channelId);
        }
        if (entry.kind === 'free-account') {
          if (account?.pendingExpirationId === entry.payload.expirationId) {
            account.pendingDelivery = this._hasPending(state, account.id);
            if (!account.pendingDelivery) account.pendingExpirationId = null;
          }
          this._audit(state, 'account.delivery-confirmed', entry.payload.accountId, null, entry.deliveredAt,
            { expirationId: entry.payload.expirationId, messageId: messageId || null });
        }
      }
      return entry;
    });
  }

  async failOutbox(id, error) {
    return this._mutate((state) => {
      const entry = state.outbox[id];
      if (!entry) throw new Error('Entrega não encontrada.');
      if (entry.status === 'delivered') return entry;
      entry.attempts += 1;
      // External errors may contain request bodies. Keep only a generic classification, never credentials.
      entry.lastError = error?.code ? `Falha de entrega (${String(error.code).slice(0, 80)})` : 'Falha de entrega no Discord; aguardando nova tentativa.';
      entry.lastAttemptAt = new Date().toISOString();
      return entry;
    });
  }

  async pendingDeliveryForAccount(guildId, accountId) {
    this._guild(guildId); await this._ready();
    return Boolean(this._current().accounts[accountId]?.pendingDelivery || this._hasPending(this._current(), accountId));
  }

  async listAudit(guildId, { limit, offset = 0 } = {}) {
    this._guild(guildId); await this._ready();
    const entries = this._current().audit.slice().reverse();
    return structuredClone(entries.slice(offset, limit === undefined ? undefined : offset + limit));
  }

  async exportSnapshot() {
    return this._serialized(async () => {
      await this._refresh();
      return this._snapshotBuffer();
    });
  }

  _snapshotBuffer() {
    const data = { sequence: this._sequence, lastEventId: this._lastEventId, state: this._state };
    return Buffer.from(JSON.stringify({ format: SNAPSHOT_FORMAT, guildId: this.guildId, encrypted: true,
      createdAt: new Date().toISOString(), data: encryptString(JSON.stringify(data), this.key, `snapshot:${this.guildId}`) }));
  }

  get sequence() { return this._sequence; }

  async checkpoint() {
    return this._serialized(async () => { await this._refresh(); return this._checkpoint(); });
  }

  async checkpointIfNeeded(interval = 250) {
    if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('Intervalo de checkpoint inválido.');
    return this._serialized(async () => {
      await this._refresh();
      if (this._sequence - this._lastCheckpointSequence < interval) return null;
      return this._checkpoint();
    });
  }

  async _checkpoint() {
    const message = await this.channel.send({ content: `UF4 SNAPSHOT ${this._sequence}`,
      files: [{ attachment: this._snapshotBuffer(), name: 'unlock-snapshot.json' }],
      allowedMentions: { parse: [] } });
    this._lastCheckpointSequence = this._sequence;
    this._headMessageId = String(message.id); this._latestMessageId = String(message.id);
    return { messageId: String(message.id), sequence: this._sequence };
  }

  async restoreSnapshot(buffer) {
    return this._serialized(async () => {
      await this._refresh();
      const current = this._state;
      if (Object.values(current.records).some((records) => Object.keys(records).length) ||
          ['accounts', 'counters', 'config', 'outbox'].some((key) => Object.keys(current[key]).length) || current.audit.length) {
        throw new Error('A restauração só é permitida em um canal de dados vazio.');
      }
      let envelope, restored;
      try {
        envelope = JSON.parse(Buffer.from(buffer).toString('utf8'));
        if (envelope.format !== SNAPSHOT_FORMAT || envelope.guildId !== this.guildId || !envelope.encrypted) throw new Error('Backup incompatível');
        restored = JSON.parse(decryptString(envelope.data, this.key, `snapshot:${this.guildId}`));
        this._validateSnapshot(restored);
      } catch (error) { throw new Error(`Backup inválido: ${error.message}`); }
      const message = await this.channel.send({ content: `UF4 SNAPSHOT ${restored.sequence}`,
        files: [{ attachment: Buffer.from(JSON.stringify(envelope)), name: 'unlock-snapshot.json' }],
        allowedMentions: { parse: [] } });
      this._state = restored.state; this._sequence = restored.sequence; this._lastEventId = restored.lastEventId;
      this._headMessageId = String(message.id); this._latestMessageId = String(message.id); this._loaded = true;
      this._lastCheckpointSequence = restored.sequence;
      return { records: Object.values(this._state.records).reduce((count, records) => count + Object.keys(records).length, 0),
        accounts: Object.keys(this._state.accounts).length, sequence: this._sequence };
    });
  }

  _validateSnapshot(restored) {
    const state = restored?.state;
    if (!state || state.version !== 1 || state.guildId !== this.guildId || !Number.isSafeInteger(restored.sequence) || restored.sequence < 0 ||
        !state.records || !state.accounts || !state.counters || !state.config || !state.outbox || !Array.isArray(state.audit)) {
      throw new Error('Estrutura de snapshot incompatível.');
    }
    for (const type of Object.keys(TYPES)) {
      if (!state.records[type] || Array.isArray(state.records[type])) throw new Error('Registros do snapshot incompatíveis.');
      for (const record of Object.values(state.records[type])) {
        const { passwordEncrypted, ...withoutCredential } = record;
        if (record.type !== type || record.guildId !== this.guildId || !record.id || JSON.stringify(withoutCredential) !== JSON.stringify(clean(withoutCredential)) ||
            (passwordEncrypted !== undefined && type !== 'vendas')) {
          throw new Error('Registro do snapshot inválido ou contém credenciais.');
        }
        if (passwordEncrypted !== undefined) decryptString(passwordEncrypted, this.key, `sale:${this.guildId}:${record.id}`);
      }
    }
    for (const account of Object.values(state.accounts)) {
      if (account.guildId !== this.guildId || !account.id || !account.passwordEncrypted) throw new Error('Conta do snapshot inválida.');
      this._password(account);
    }
  }

  async close() { /* Persistence belongs to Discord; no local resources exist. */ }
}

module.exports = { Store, EVENT_FORMAT, SNAPSHOT_FORMAT };

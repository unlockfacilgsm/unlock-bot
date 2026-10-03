'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits: P, PermissionsBitField, PermissionOverwrites, OverwriteType } = require('discord.js');
const { DiscordTransport, ensureDataChannel, fetchAllMessages, splitText, renderRecord, recordPages, RECORD_SEPARATOR, validateSetupPermissions, normalizeOverwrite } = require('../src/transport');
const { TOOLS } = require('../src/catalog');

function fakeChannel(id, name, messages = []) {
  let next = 0;
  const channel = {
    id, name, type: ChannelType.GuildText, sent: [], edits: [], overwrites: [],
    permissionOverwrites: { async set(value) { channel.overwrites = value; } },
    permissionsFor() { return new PermissionsBitField(P.Administrator); },
    async setParent(parent) { channel.parentId = parent; },
    async setName(value) { channel.name = value; },
    async send(payload) {
      const message = makeMessage(`sent-${++next}`, payload.content, 'bot');
      message.files = payload.files || []; message.payload = payload;
      channel.sent.push(message); messages.unshift(message); return message;
    },
    messages: { async fetch(options) {
      if (typeof options === 'string') {
        const result = messages.find(message => message.id === options);
        if (!result) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return result;
      }
      const offset = options.before ? messages.findIndex(message => message.id === options.before) + 1 : 0;
      return new Map(messages.slice(offset, offset + options.limit).map(message => [message.id, message]));
    } }
  };
  function makeMessage(messageId, content, authorId = 'bot') {
    return { id: messageId, content, author: { id: authorId }, channelId: id, async edit(payload) {
      this.content = payload.content; this.payload = payload;
      if (payload.attachments) this.files = [];
      if (payload.files) this.files = payload.files;
      channel.edits.push(payload); return this;
    } };
  }
  for (const message of messages) Object.assign(message, makeMessage(message.id, message.content, message.author?.id || 'bot'));
  channel.makeMessage = makeMessage;
  return channel;
}

function fakeGuild(channels = []) {
  let next = 1;
  const cache = new Map(channels.map(channel => [channel.id, channel]));
  return {
    id: 'guild', members: { me: { id: 'bot', permissions: new PermissionsBitField(P.Administrator) } },
    roles: { everyone: { id: 'everyone' }, cache: new Map([['admin', {}], ['seller', {}]]), async fetch() {} },
    channels: { cache, async fetch(id) { return id ? cache.get(id) : cache; }, async create(options) {
      const channel = fakeChannel(`new-${next++}`, options.name);
      channel.type = options.type; channel.overwrites = options.permissionOverwrites; channel.parentId = options.parent;
      cache.set(channel.id, channel); return channel;
    } }
  };
}

function fakeStore(config = {}, items = []) {
  const records = new Map(), accounts = new Map();
  return {
    records, accounts, config, failures: [], queue: items,
    async getConfig(guildId, key, fallback) { return this.config[key] ?? fallback; },
    async setConfig(guildId, key, value) { this.config[key] = structuredClone(value); },
    async listOutbox() { return this.queue.filter(item => !item.delivered); },
    async getRecord(guildId, type, id) { return records.get(id); },
    async getAccount(guildId, id) { return accounts.get(id); },
    async completeOutbox(id, metadata) {
      const item = this.queue.find(value => value.id === id); item.delivered = true;
      if (item.kind === 'record' && metadata.messageId) Object.assign(records.get(item.payload.id), metadata);
      if (['account', 'free-account'].includes(item.kind) && metadata.messageId) {
        const account = accounts.get(item.payload.accountId);
        account.freeMessageId = metadata.messageId; account.freeChannelId = metadata.channelId;
      }
    },
    async failOutbox(id, error) { this.failures.push({ id, error }); },
    async listRecords() { return [...records.values()]; },
    async queueOutbox(guildId, kind, payload, dedupeKey) {
      if (!this.queue.some(item => item.dedupeKey === dedupeKey)) this.queue.push({ id: `out-${this.queue.length}`, kind, payload, dedupeKey });
    }
  };
}

test('history reads more than the old 2000-message ceiling', async () => {
  const messages = Array.from({ length: 2105 }, (_, i) => ({ id: String(i), content: '' }));
  const all = await fetchAllMessages(fakeChannel('history', 'history', messages));
  assert.equal(all.length, 2105); assert.equal(new Set(all.map(message => message.id)).size, 2105);
});

test('pagination stays within Discord limits and preserves Unicode', () => {
  const original = '😀'.repeat(2500);
  const pages = splitText(original);
  assert.ok(pages.every(page => page.length <= 1900));
  assert.equal(pages.join(''), original);
  assert.ok(pages.every(page => !/[\uD800-\uDBFF]$/.test(page)));
});

test('private sales show explicit passwords and separators but never ciphertext or arbitrary fields', () => {
  const result = renderRecord({ id: 'VEN-1', type: 'vendas', client: '@everyone', tool: 'Unlock Tool', password: 'secret', passwordEncrypted: 'encrypted-secret', rawLegacy: 'other-secret', priceCents: 1000 });
  assert.ok(result.includes('Senha: secret')); assert.ok(result.includes('10,00'));
  assert.ok(!result.includes('encrypted-secret')); assert.ok(!result.includes('other-secret'));
  assert.ok(result.startsWith(RECORD_SEPARATOR)); assert.ok(result.endsWith(RECORD_SEPARATOR));
});

test('record pages retain one recovery marker inside separators and respect message limits', () => {
  const pages = recordPages({ id: 'VEN-1', type: 'vendas', client: '😀'.repeat(1800), password: ' $&`_ ', tool: 'Unlock Tool' }, 'UF4:record:event-1');
  assert.ok(pages.length > 1);
  for (const [index, page] of pages.entries()) {
    const marker = `UF4:record:event-1${index ? `:${index}` : ''}`;
    assert.ok(page.length <= 2000);
    assert.ok(page.startsWith(RECORD_SEPARATOR));
    assert.ok(page.endsWith(`${marker}\n${RECORD_SEPARATOR}`));
    assert.equal(page.split('\n').filter(line => line.startsWith('UF4:')).length, 1);
  }
});

test('a crash after send is recovered by own-author marker without duplication', async () => {
  const channel = fakeChannel('sales', 'sales');
  const guild = fakeGuild([channel]);
  const item = { id: 'out-1', kind: 'record', payload: { type: 'vendas', id: 'VEN-1' } };
  const store = fakeStore({ channels: { vendas: channel.id } }, [item]);
  store.records.set('VEN-1', { id: 'VEN-1', type: 'vendas', client: 'Cliente', tool: 'Unlock Tool' });
  const complete = store.completeOutbox.bind(store);
  let crash = true;
  store.completeOutbox = async (...args) => { if (crash) { crash = false; throw new Error('Simulated crash before persistence'); } return complete(...args); };
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  assert.equal((await transport.flush(guild)).errors.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal((await transport.flush(guild)).delivered, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].payload.allowedMentions.parse.length, 0);
});

test('markers from another author do not impersonate delivery', async () => {
  const channel = fakeChannel('sales', 'sales', [{ id: 'fake', content: 'UF4:record:out-1', author: { id: 'attacker' } }]);
  const store = fakeStore({ channels: { vendas: 'sales' } }, [{ id: 'out-1', kind: 'record', payload: { type: 'vendas', id: 'VEN-1' } }]);
  store.records.set('VEN-1', { id: 'VEN-1', type: 'vendas', tool: 'Unlock Tool', client: 'Cliente' });
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await transport.flush(fakeGuild([channel])); assert.equal(channel.sent.length, 1);
});

test('selling an account removes its previous credentials attachment', async () => {
  const channel = fakeChannel('free', 'free');
  const store = fakeStore({ channels: { unlockTool: 'free' } }, [{ id: 'out-1', kind: 'account', payload: { accountId: 'ACC-1' } }]);
  const account = { id: 'ACC-1', tool: 'Unlock Tool', login: 'login', password: ' $&``` ', status: 'available' };
  store.accounts.set(account.id, account);
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  const guild = fakeGuild([channel]);
  await transport.flush(guild);
  assert.equal(JSON.parse(channel.sent[0].files[0].attachment.toString()).password, account.password);
  account.status = 'occupied'; account.activeSaleId = 'VEN-1';
  store.queue.push({ id: 'out-2', kind: 'account', payload: { accountId: account.id } });
  await transport.flush(guild);
  assert.equal(channel.sent.length, 1); assert.equal(channel.sent[0].files.length, 0);
  assert.ok(channel.sent[0].content.includes('OCUPADA'));
  assert.ok(!channel.sent[0].content.includes('$&'));
});

test('a failed publication does not complete a free-account delivery', async () => {
  const channel = fakeChannel('free', 'free');
  channel.send = async () => { throw new Error('Discord unavailable'); };
  const store = fakeStore({ channels: { unlockTool: 'free' } }, [{ id: 'release', kind: 'free-account', payload: { accountId: 'ACC-1', expirationId: 'VENC-1' } }]);
  store.accounts.set('ACC-1', { id: 'ACC-1', tool: 'Unlock Tool', login: 'login', password: 'secret', status: 'available', pendingDelivery: true, pendingExpirationId: 'VENC-1' });
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  const result = await transport.flush(fakeGuild([channel]));
  assert.equal(result.errors.length, 1); assert.ok(!store.queue[0].delivered);
  assert.equal(store.accounts.get('ACC-1').pendingDelivery, true);
});

test('old release outbox cannot publish an occupied account as free', async () => {
  const channel = fakeChannel('free', 'free');
  const store = fakeStore({ channels: { unlockTool: 'free' } }, [{ id: 'old', kind: 'free-account', payload: { accountId: 'ACC-1', expirationId: 'VENC-old' } }]);
  store.accounts.set('ACC-1', { id: 'ACC-1', tool: 'Unlock Tool', status: 'occupied', activeSaleId: 'VEN-new' });
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  assert.equal((await transport.flush(fakeGuild([channel]))).skipped, 1);
  assert.equal(channel.sent.length, 0);
});

test('setup uses persisted IDs, preserves legacy channels and restricts data to admin', async () => {
  const legacy = fakeChannel('legacy', '💰・vendas');
  const data = fakeChannel('data', '🤖・dados-bot');
  const guild = fakeGuild([legacy, data]);
  const store = fakeStore(); store.channel = data;
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await transport.setup(guild, { adminRoleId: 'admin', sellerRoleId: 'seller' });
  const sales = await transport.getChannel(guild, 'vendas');
  assert.notEqual(sales.id, legacy.id); assert.equal(legacy.name, '💰・vendas');
  assert.ok(data.overwrites.some(rule => rule.id === 'everyone' && rule.deny.includes(P.ViewChannel)));
  assert.ok(!data.overwrites.some(rule => rule.id === 'seller'));
  assert.ok(sales.overwrites.some(rule => rule.id === 'seller' && rule.allow.includes(P.ViewChannel)));
  sales.name = 'renamed'; assert.equal((await transport.getChannel(guild, 'vendas')).id, sales.id);
});

test('data bootstrap repairs a pre-existing channel privacy', async () => {
  const channel = fakeChannel('data', '🤖・dados-bot');
  const result = await ensureDataChannel(fakeGuild([channel]), { client: { user: { id: 'bot' } }, adminRoleId: 'admin', sellerRoleId: 'seller' });
  assert.equal(result.id, 'data');
  assert.ok(channel.overwrites.some(rule => rule.id === 'everyone' && rule.deny.includes(P.ViewChannel)));
  assert.ok(!channel.overwrites.some(rule => rule.id === 'seller'));
});

test('data bootstrap retains saved admin access until configuration is loaded', async () => {
  const channel = fakeChannel('data', 'renamed-data');
  channel.topic = 'UF4: armazenamento criptografado do bot; não apague mensagens.';
  channel.permissionOverwrites.cache = new Map([['configured-admin', { id: 'configured-admin', type: OverwriteType.Role, allow: [P.ViewChannel] }]]);
  const result = await ensureDataChannel(fakeGuild([channel]), { client: { user: { id: 'bot' } } });
  assert.equal(result.id, 'data');
  assert.ok(channel.overwrites.some(rule => rule.id === 'configured-admin'));
});

test('explicit invalid data channel selection fails before creating or editing channels', async () => {
  const unrelated = fakeChannel('general', 'general');
  const guild = fakeGuild([unrelated]);
  await assert.rejects(ensureDataChannel(guild, { client: { user: { id: 'bot' } }, channelId: 'missing' }), /não existe/);
  await assert.rejects(ensureDataChannel(guild, { client: { user: { id: 'bot' } }, channelId: unrelated.id }), /não identifica/);
  assert.equal(guild.channels.cache.size, 1); assert.equal(unrelated.overwrites.length, 0);
});

test('backup publication rejects a plaintext snapshot', async () => {
  const channel = fakeChannel('backup', 'backup');
  const store = fakeStore({ channels: { backups: 'backup' } });
  store.exportSnapshot = async () => Buffer.from(JSON.stringify({ state: { password: 'secret' } }));
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await assert.rejects(transport.backup(fakeGuild([channel])), /criptografado/);
  assert.equal(channel.sent.length, 0);
  store.exportSnapshot = async () => Buffer.from(JSON.stringify({ encrypted: true, data: 'encrypted' }));
  await transport.backup(fakeGuild([channel])); assert.equal(channel.sent.length, 1);
});

test('reminders dedupe per deadline and ignore renewed stale publications', async () => {
  const channel = fakeChannel('alerts', 'alerts');
  const store = fakeStore({ channels: { alertas: 'alerts' }, alerts: { enabled: true, leadMinutes: 60 } });
  const sale = { id: 'VEN-1', type: 'vendas', tool: 'Unlock Tool', client: 'Cliente', plan: '12 horas', status: 'active', expiresAt: '2026-10-02T12:30:00.000Z', accountId: 'ACC-1' };
  store.records.set(sale.id, sale); store.accounts.set('ACC-1', { activeSaleId: sale.id });
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS, clock: () => new Date('2026-10-02T12:00:00Z') });
  const guild = fakeGuild([channel]); await transport.reminders(guild); await transport.reminders(guild);
  assert.equal(store.queue.length, 1);
  sale.expiresAt = '2026-10-03T12:30:00.000Z';
  assert.equal((await transport.flush(guild)).skipped, 1); assert.equal(channel.sent.length, 0);
});

test('real Store serializes a concurrent sale behind credential publication', async () => {
  const { Store } = require('../src/store');
  const free = fakeChannel('free', 'free');
  const data = fakeChannel('data-race', 'data');
  const downloads = new Map();
  const sendData = data.send.bind(data);
  let sequence = 0;
  data.send = async payload => {
    const message = await sendData(payload);
    message.createdTimestamp = ++sequence; message.attachments = new Map();
    for (const file of payload.files || []) {
      const url = `memory://${message.id}/${file.name}`;
      downloads.set(url, file.attachment); message.attachments.set(file.name, { name: file.name, url });
    }
    return message;
  };
  const store = new Store({ channel: data, guildId: 'guild', botId: 'bot', encryptionKey: Buffer.alloc(32, 3), downloadAttachment: async url => downloads.get(url) });
  await store.load();
  await store.setConfig('guild', 'channels', { unlockTool: 'free', vendas: 'sales' });
  const account = await store.upsertAccount('guild', { tool: 'Unlock Tool', login: 'race-login', password: 'race-password' });
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  const guild = fakeGuild([data, free, fakeChannel('sales', 'sales')]);
  let entered, resume;
  const reachedSend = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const sendFree = free.send.bind(free);
  free.send = async payload => { entered(); await gate; return sendFree(payload); };
  const publishing = transport.flush(guild);
  await reachedSend;
  const selling = store.createSale('guild', { accountId: account.id, client: 'Cliente', tool: account.tool, plan: '12 horas', priceCents: 1000, registeredAt: '2090-01-01T12:00:00Z' });
  await Promise.resolve();
  assert.equal((await store.getAccount('guild', account.id)).status, 'available');
  resume(); await publishing;
  const sale = await selling;
  assert.equal((await store.getAccount('guild', account.id)).activeSaleId, sale.id);
  await transport.flush(guild);
  assert.equal(free.sent[0].files.length, 0); assert.ok(free.sent[0].content.includes('OCUPADA'));
});

test('Discord.js resolves every setup overwrite without cached users or roles', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  const guild = fakeGuild([data]);
  const store = fakeStore(); store.channel = data;
  const transport = new DiscordTransport({ client: { user: { id: 'uncached-bot' } }, store, catalog: TOOLS });
  await transport.setup(guild, { adminRoleId: 'admin', sellerRoleId: 'seller' });
  const uncached = { roles: { resolve() { return null; } }, client: { users: { resolve() { return null; } } } };
  assert.throws(() => PermissionOverwrites.resolve({ id: 'uncached-bot', allow: [P.ViewChannel] }, uncached), error => error.code === 'InvalidType');
  for (const channel of guild.channels.cache.values()) {
    for (const overwrite of channel.overwrites) {
      const resolved = PermissionOverwrites.resolve(overwrite, uncached);
      assert.equal(resolved.type, overwrite.id === 'uncached-bot' ? OverwriteType.Member : OverwriteType.Role);
      assert.ok(!new PermissionsBitField(resolved.allow).has(P.ManageMessages, false));
    }
  }
});

test('cached Discord.js PermissionOverwrites normalize to cache-independent payloads', () => {
  const cached = new PermissionOverwrites({}, { id: 'not-cached-role', type: OverwriteType.Role, allow: String(P.ViewChannel | P.ReadMessageHistory), deny: String(P.SendMessages) }, {});
  const normalized = normalizeOverwrite(cached);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(normalized.type, OverwriteType.Role);
  const result = PermissionOverwrites.resolve(normalized, { roles: { resolve() { throw new Error('Must not resolve role cache'); } } });
  assert.equal(result.allow, String(P.ViewChannel | P.ReadMessageHistory));
  assert.equal(result.deny, String(P.SendMessages));
});

test('missing ManageRoles fails setup clearly before any mutation', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  const guild = fakeGuild([data]);
  guild.members.me.permissions = new PermissionsBitField([P.ManageChannels, P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks]);
  const store = fakeStore(); store.channel = data;
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await assert.rejects(transport.setup(guild), error => error.code === 'BOT_MISSING_PERMISSIONS' && /Gerenciar Cargos/.test(error.message));
  assert.equal(guild.channels.cache.size, 1); assert.deepEqual(store.config, {}); assert.equal(data.overwrites.length, 0);
});

test('target channel permission denial is identified before setup creates categories', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  data.permissionsFor = () => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.ManageChannels]);
  const guild = fakeGuild([data]);
  const store = fakeStore(); store.channel = data;
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await assert.rejects(transport.setup(guild), error => /Gerenciar Cargos.*dados-bot/.test(error.message));
  assert.equal(guild.channels.cache.size, 1); assert.deepEqual(store.config, {});
});

test('managed and everyone staff roles are rejected before channel mutation', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  const guild = fakeGuild([data]); guild.roles.cache.set('integration', { managed: true });
  const store = fakeStore(); store.channel = data;
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await assert.rejects(transport.setup(guild, { adminRoleId: guild.roles.everyone.id }), /@everyone/);
  await assert.rejects(transport.setup(guild, { sellerRoleId: 'integration' }), /gerenciados/);
  assert.equal(guild.channels.cache.size, 1); assert.equal(data.overwrites.length, 0); assert.deepEqual(store.config, {});
});

test('secure existing data channel starts without ManageRoles or ACL mutations', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  data.topic = 'UF4: armazenamento criptografado do bot; não apague mensagens.';
  const dataRights = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles];
  data.permissionOverwrites.cache = new Map([
    ['everyone', new PermissionOverwrites({}, { id: 'everyone', type: OverwriteType.Role, allow: '0', deny: String(P.ViewChannel) }, data)],
    ['bot', new PermissionOverwrites({}, { id: 'bot', type: OverwriteType.Member, allow: String(PermissionsBitField.resolve(dataRights)), deny: '0' }, data)]
  ]);
  const guild = fakeGuild([data]);
  guild.members.me.permissions = new PermissionsBitField(dataRights);
  data.permissionsFor = () => new PermissionsBitField(dataRights);
  const result = await ensureDataChannel(guild, { client: { user: { id: 'bot' } } });
  assert.equal(result.id, data.id); assert.equal(data.overwrites.length, 0); assert.equal(guild.channels.cache.size, 1);
});

test('startup never ignores missing history access on an otherwise protected data channel', async () => {
  const data = fakeChannel('data', '🤖・dados-bot');
  const allow = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.AttachFiles;
  data.permissionOverwrites.cache = new Map([
    ['everyone', { id: 'everyone', type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel }],
    ['bot', { id: 'bot', type: OverwriteType.Member, allow, deny: 0n }]
  ]);
  data.permissionsFor = () => new PermissionsBitField([P.ViewChannel, P.SendMessages, P.AttachFiles]);
  await assert.rejects(ensureDataChannel(fakeGuild([data]), { client: { user: { id: 'bot' } } }), error => /Ler Histórico.*dados-bot/.test(error.message));
  assert.equal(data.overwrites.length, 0);
});

test('setup ignores unrelated restricted channels outside its persisted mapping', async () => {
  const unrelated = fakeChannel('other', 'unrelated'); unrelated.permissionsFor = () => new PermissionsBitField();
  const data = fakeChannel('data', '🤖・dados-bot');
  const store = fakeStore(); store.channel = data;
  const guild = fakeGuild([data, unrelated]);
  const transport = new DiscordTransport({ client: { user: { id: 'bot' } }, store, catalog: TOOLS });
  await transport.setup(guild);
  assert.equal(unrelated.overwrites.length, 0);
});

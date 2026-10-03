'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { Store } = require('../src/store');
const { DiscordTransport } = require('../src/transport');
const { BotApp } = require('../src/app');
const catalog = require('../src/catalog');

function fixture(clock = () => new Date()) {
  let nextId = 0;
  const downloads = new Map();
  const cache = new Map();
  const client = { user: { id: 'bot', tag: 'TestBot' } };
  const guild = { id: 'guild', members: { me: { id: 'bot', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) } }, roles: { everyone: { id: 'guild' }, cache: new Map([['seller', { id: 'seller' }], ['admin', { id: 'admin' }]]), async fetch(id) { return this.cache.get(id); } } };
  function channel(spec) {
    const history = new Map(), nonces = new Map();
    const result = {
      ...spec, id: String(++nextId), guildId: guild.id, guild, client, history, permissionOverwrites: { async set() {} },
      permissionsFor() { return guild.members.me.permissions; },
      async setParent(parentId) { result.parentId = parentId; }, async setName(name) { result.name = name; }, async setTopic(topic) { result.topic = topic; },
      messages: { async fetch(options) {
        if (typeof options === 'string') {
          const message = history.get(options);
          if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          return message;
        }
        return new Map([...history.values()].filter(message => !options.before || BigInt(message.id) < BigInt(options.before)).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, options.limit).map(message => [message.id, message]));
      } },
      async send(payload) {
        assert.ok((payload.content?.length || 0) <= 2000);
        if (payload.enforceNonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce);
        const id = String(++nextId);
        const message = { id, channelId: result.id, author: client.user, content: payload.content || '', createdTimestamp: Date.now(), createdAt: new Date(), url: `https://discord.com/channels/${guild.id}/${result.id}/${id}`, attachments: new Map(),
          async edit(update) {
            if (update.content != null) { assert.ok(update.content.length <= 2000); message.content = update.content; }
            if (update.attachments) message.attachments.clear();
            files(message, update.files || []);
            return message;
          }
        };
        files(message, payload.files || []);
        history.set(id, message);
        if (payload.enforceNonce) nonces.set(payload.nonce, message);
        return message;
      }
    };
    function files(message, attachments) {
      for (const file of attachments) {
        const url = `memory://${result.id}/${message.id}/${file.name}`;
        downloads.set(url, Buffer.from(file.attachment));
        message.attachments.set(file.name, { name: file.name, url });
      }
    }
    cache.set(result.id, result);
    return result;
  }
  guild.channels = { cache, async fetch(id) { return id ? cache.get(id) : cache; }, async create(spec) { return channel(spec); } };
  const data = channel({ name: 'data', type: ChannelType.GuildText });
  const store = new Store({ channel: data, encryptionKey: Buffer.alloc(32, 7), guildId: guild.id, botId: client.user.id, clock, downloadAttachment: async url => downloads.get(url) });
  return { client, guild, store, data, downloads };
}

function interaction(guild, commandName, values = {}, subcommand) {
  return { guild, channelId: 'panel', commandName, user: { id: 'seller-user' }, member: { roles: ['seller'] }, memberPermissions: { has: () => false }, deferred: false,
    isChatInputCommand: () => true, isAutocomplete: () => false,
    options: { getString: name => values[name] ?? null, getNumber: name => values[name] ?? null, getBoolean: name => values[name] ?? null, getInteger: name => values[name] ?? null, getSubcommand: () => subcommand },
    async deferReply() { this.deferred = true; }, async editReply(reply) { this.output = reply; }, async fetchReply() { return { createMessageComponentCollector: () => ({ on() {} }) }; }
  };
}

test('Discord-backed application completes stock, sale, renewal, expiry, confirmed release and restart', async () => {
  let now = new Date('2026-10-02T13:00:00Z');
  const f = fixture(() => now);
  await f.store.load();
  const transport = new DiscordTransport({ client: f.client, store: f.store, catalog, clock: () => now });
  await transport.setup(f.guild, { adminRoleId: 'admin', sellerRoleId: 'seller' });
  const channels = await f.store.getConfig(f.guild.id, 'channels');
  const app = new BotApp({ client: f.client, store: f.store, transport, guildId: f.guild.id, clock: () => now, logger: { error() {} } });
  const invoke = async (name, values, subcommand) => {
    const request = interaction(f.guild, name, values, subcommand);
    request.channelId = channels.painel;
    await app.handle(request);
    assert.ok(!request.output.content.startsWith('❌'), request.output.content);
    return request.output;
  };
  await invoke('conta', { ferramenta: 'Unlock Tool', login: 'exact-login', senha: ' a$&`b ' }, 'adicionar');
  let account = (await f.store.listAccounts(f.guild.id))[0];
  const freeChannel = await transport.getChannel(f.guild, 'unlockTool');
  assert.equal(freeChannel.history.size, 1);
  assert.equal([...freeChannel.history.values()][0].attachments.size, 1);
  await invoke('vender', { cliente: 'Cliente', ferramenta: 'Unlock Tool', plano: '12 horas', conta: account.id });
  const sale = (await f.store.listRecords(f.guild.id, 'vendas'))[0];
  assert.equal(sale.priceCents, 1000);
  assert.equal([...freeChannel.history.values()][0].attachments.size, 0);
  await invoke('renovar', { venda: sale.id, plano: '3 meses', desconto: 5 });
  const renewed = await f.store.getRecord(f.guild.id, 'vendas', sale.id);
  assert.equal(renewed.plan, '12 horas');
  assert.equal(renewed.priceCents, 1000);
  const panel = await invoke('painel', {});
  assert.ok(panel.content.includes('R$ 60,00') || panel.content.includes('R$ 60,00'));
  now = new Date(Date.parse(renewed.expiresAt) + 60_000);
  await app.tick(f.guild);
  const expiration = (await f.store.listRecords(f.guild.id, 'vencimentos')).find(record => record.status === 'pending');
  assert.ok(expiration);
  await invoke('trocar-senhas', { vencimentos: expiration.id, nova_senha: ' next$&`password ', confirmada: true });
  account = await f.store.getAccount(f.guild.id, sale.accountId);
  assert.equal(account.status, 'available'); assert.equal(account.pendingDelivery, false);
  assert.equal(account.password, ' next$&`password ');
  assert.equal(freeChannel.history.size, 1, 'free-account updates its existing mirror');
  const persisted = new Store({ channel: f.data, guildId: f.guild.id, botId: f.client.user.id, encryptionKey: Buffer.alloc(32, 7), downloadAttachment: async url => f.downloads.get(url) });
  await persisted.load();
  assert.equal((await persisted.getAccount(f.guild.id, account.id)).password, account.password);
  assert.equal((await persisted.getRecord(f.guild.id, 'vendas', sale.id)).status, 'released');
  const allEvents = [...f.data.history.values()].flatMap(message => [...message.attachments.values()]).filter(file => file.name === 'unlock-event.json').map(file => f.downloads.get(file.url).toString());
  assert.ok(allEvents.every(event => !event.includes('next$&') && !event.includes(' a$&')));
  await invoke('vender', { cliente: 'Novo cliente', ferramenta: 'Unlock Tool', plano: '12 horas', conta: account.id });
  assert.equal((await f.store.listRecords(f.guild.id, 'vendas')).length, 2);
});

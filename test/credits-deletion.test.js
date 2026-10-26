'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { Store } = require('../src/store');
const { DiscordTransport, renderRecord } = require('../src/transport');
const { BotApp } = require('../src/app');
const { buildCommands } = require('../src/commands');
const catalog = require('../src/catalog');
const validation = require('../src/validation');
const { calculateExpiration, formatBR } = require('../src/dates');

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
        if (payload.enforceNonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce);
        const id = String(++nextId);
        const message = { id, channelId: result.id, author: payload.author || client.user, content: payload.content || '', createdTimestamp: Date.now(), attachments: new Map(),
          async edit(update) {
            if (update.content != null) message.content = update.content;
            if (update.attachments) message.attachments.clear();
            files(message, update.files || []);
            return message;
          },
          async delete() { history.delete(id); }
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

function interaction(guild, commandName, values = {}, subcommand, roles = ['seller']) {
  return { guild, channelId: 'panel', commandName, user: { id: 'operator' }, member: { roles }, memberPermissions: { has: () => false }, deferred: false,
    isChatInputCommand: () => true, isAutocomplete: () => false,
    options: { getString: name => values[name] ?? null, getNumber: name => values[name] ?? null, getBoolean: name => values[name] ?? null, getInteger: name => values[name] ?? null, getSubcommand: () => subcommand },
    async deferReply() { this.deferred = true; }, async editReply(reply) { this.output = reply; }, async fetchReply() { return { createMessageComponentCollector: () => ({ on() {} }) }; }
  };
}

async function setup(clock) {
  const f = fixture(clock);
  await f.store.load();
  const transport = new DiscordTransport({ client: f.client, store: f.store, catalog, clock });
  await transport.setup(f.guild, { adminRoleId: 'admin', sellerRoleId: 'seller' });
  const channels = await f.store.getConfig(f.guild.id, 'channels');
  const app = new BotApp({ client: f.client, store: f.store, transport, guildId: f.guild.id, clock, logger: { error() {} } });
  const run = async (name, values, subcommand, roles) => {
    const request = interaction(f.guild, name, values, subcommand, roles);
    request.channelId = channels.painel;
    await app.handle(request);
    return request.output.content;
  };
  const freeChannel = await transport.getChannel(f.guild, 'unlockTool');
  return { ...f, transport, app, run, freeChannel };
}

const posted = channel => [...channel.history.values()].map(message => message.content);

test('credit plan costs R$ 5,00 per credit and the 6-month plan has an expiration', () => {
  assert.equal(catalog.isCreditPlan('Unlock Tool', 'Créditos'), true);
  assert.equal(catalog.isCreditPlan('Unlock Tool', '1 mês'), false);
  assert.deepEqual(validation.amounts('Unlock Tool', 'Créditos', null, null, 3), { priceCents: 1500, discountCents: 0 });
  assert.deepEqual(validation.amounts('TSM Tool', 'Créditos', null, 2, 10), { priceCents: 4800, discountCents: 200 });
  assert.deepEqual(validation.amounts('AMT Tool', 'Créditos', 40, null, 10), { priceCents: 4000, discountCents: 0 });
  assert.throws(() => validation.amounts('Unlock Tool', 'Créditos', null, null, 0), /créditos/i);
  assert.equal(validation.amounts('Unlock Tool', '1 mês', null, null, 7).priceCents, 3000);
  assert.deepEqual(catalog.planChoices('Unlock Tool', 'cred').map(choice => choice.value), ['Créditos']);
  assert.match(catalog.planChoices('Unlock Tool', 'cred')[0].name, /^Créditos — R\$\s5,00 por crédito$/);
  assert.equal(catalog.planChoices('Unlock Tool', '', { credits: false }).some(choice => choice.value === 'Créditos'), false);
  assert.equal(formatBR(calculateExpiration('6 meses', new Date('2026-01-15T12:00:00-03:00'))), '15/07/2026 12:00');
});

test('/vender plano Créditos records the amount without reserving stock or expiring', async () => {
  let now = new Date('2026-10-02T13:00:00Z');
  const f = await setup(() => now);
  await f.run('conta', { ferramenta: 'Unlock Tool', login: 'stock-login', senha: 'stock-pass' }, 'adicionar');
  const reply = await f.run('vender', { cliente: 'Cliente', ferramenta: 'Unlock Tool', plano: 'Créditos', creditos: 4, login: 'cliente-login' });
  assert.match(reply, /4 crédito\(s\)/); assert.match(reply, /R\$\s20,00/);
  const [sale] = await f.store.listRecords(f.guild.id, 'vendas');
  assert.equal(sale.credits, 4); assert.equal(sale.priceCents, 2000); assert.equal(sale.status, 'completed');
  assert.equal(sale.expiresAt, undefined); assert.equal(sale.accountId, undefined); assert.equal(sale.login, 'cliente-login');
  assert.equal((await f.store.listAccounts(f.guild.id))[0].status, 'available', 'stock is untouched');
  const display = await f.store.getDisplayRecord(f.guild.id, 'vendas', sale.id);
  assert.match(renderRecord(display), /Créditos: 4/);
  assert.doesNotMatch(renderRecord(display), /Senha|Vencimento/);

  assert.match(await f.run('vender', { cliente: 'C', ferramenta: 'Unlock Tool', plano: 'Créditos' }), /❌.*creditos/);
  assert.match(await f.run('vender', { cliente: 'C', ferramenta: 'Unlock Tool', plano: 'Créditos', creditos: 2, conta: 'ACC-001' }), /❌.*não usa conta/);
  assert.match(await f.run('vender', { cliente: 'C', ferramenta: 'Unlock Tool', plano: '12 horas', creditos: 2, conta: 'ACC-001' }), /❌.*plano Créditos/);
  assert.match(await f.run('renovar', { venda: sale.id, plano: '1 mês' }), /❌.*não tem renovação/);
  assert.match(await f.run('editar-venda', { venda: sale.id, cliente: 'Corrigido', desconto: 5 }), /✅/);
  const edited = await f.store.getRecord(f.guild.id, 'vendas', sale.id);
  assert.equal(edited.client, 'Corrigido'); assert.equal(edited.priceCents, 1500);

  now = new Date('2027-10-02T13:00:00Z');
  await f.app.tick(f.guild);
  assert.equal((await f.store.listRecords(f.guild.id, 'vencimentos')).length, 0, 'credits never expire');
  const panel = posted(await f.transport.getChannel(f.guild, 'painel')).join('\n');
  assert.match(panel, /Créditos — R\$\s5,00 por crédito/);
});

test('/conta excluir removes the account and its post; protects active sales; admin only', async () => {
  // The store compares sale status with the real clock, so the sale must be active now.
  let now = new Date();
  const f = await setup(() => now);
  for (const login of ['a', 'b', 'c']) await f.run('conta', { ferramenta: 'Unlock Tool', login, senha: 'p' }, 'adicionar');
  assert.equal(f.freeChannel.history.size, 3);
  await f.run('vender', { cliente: 'Cliente', ferramenta: 'Unlock Tool', plano: '12 horas', conta: 'ACC-002' });

  assert.match(await f.run('conta', { contas: 'ACC-001', confirmar: true }, 'excluir'), /não está autorizado/);
  assert.match(await f.run('conta', { contas: 'ACC-001', confirmar: false }, 'excluir', ['admin']), /confirme explicitamente/);
  assert.equal((await f.store.listAccounts(f.guild.id)).length, 3);

  const reply = await f.run('conta', { contas: 'acc-001, ACC-002,ACC-999', confirmar: true }, 'excluir', ['admin']);
  assert.match(reply, /1 de 3 conta\(s\) excluída/);
  assert.match(reply, /ACC-002: A conta está em uso na venda VEN-001/);
  assert.match(reply, /ACC-999: Conta não encontrada/);
  assert.deepEqual((await f.store.listAccounts(f.guild.id)).map(account => account.id), ['ACC-002', 'ACC-003']);
  assert.ok(!posted(f.freeChannel).some(content => content.includes('CONTA ACC-001')), 'the deleted account post is removed');
  assert.ok(posted(f.freeChannel).some(content => content.includes('CONTA ACC-003')));
  assert.deepEqual(await f.store.listOutbox(f.guild.id), []);
  const audit = await f.store.listAudit(f.guild.id);
  assert.ok(audit.some(event => event.action === 'account.deleted' && event.entity === 'ACC-001' && event.actorId === 'operator'));

  // After expiry the account awaits a password change and may now be removed, closing its pending expiration.
  now = new Date(Date.now() + 2 * 86_400_000);
  await f.app.tick(f.guild);
  const [expiration] = await f.store.listRecords(f.guild.id, 'vencimentos');
  assert.equal(expiration.status, 'pending');
  assert.match(await f.run('excluir', { tipo: 'contas', id: 'ACC-002', confirmar: true }, undefined, ['admin']), /vencimento pendente da venda VEN-001 foi encerrado/);
  assert.equal((await f.store.getRecord(f.guild.id, 'vencimentos', expiration.id)).status, 'cancelled');
  assert.equal((await f.store.getRecord(f.guild.id, 'vendas', 'VEN-001')).status, 'released');
  await f.app.tick(f.guild);
  assert.equal((await f.store.listRecords(f.guild.id, 'vencimentos')).length, 1, 'no new expiration is created');
  assert.ok(!posted(f.freeChannel).some(content => content.includes('CONTA ACC-002')));
  assert.match(await f.run('vencidas', {}), /Nenhum vencimento pendente/);

  const reloaded = new Store({ channel: f.data, guildId: f.guild.id, botId: 'bot', encryptionKey: Buffer.alloc(32, 7), downloadAttachment: async url => f.downloads.get(url) });
  await reloaded.load();
  assert.deepEqual((await reloaded.listAccounts(f.guild.id)).map(account => account.id), ['ACC-003']);
});

test('accounts awaiting a password reset after /troca can be deleted', async () => {
  const f = await setup(() => new Date('2026-10-02T13:00:00Z'));
  await f.run('vender', { cliente: 'Cliente', ferramenta: 'Unlock Tool', plano: '1 mês', login: 'old', senha: 'p' });
  await f.run('troca', { venda: 'VEN-001', plano_anterior: '1 mês', plano_novo: '1 mês', login: 'new', senha: 'q' });
  const old = await f.store.getAccount(f.guild.id, 'ACC-001');
  assert.equal(old.needsPasswordReset, true);
  assert.match(await f.run('conta', { contas: 'ACC-001', confirmar: true }, 'excluir', ['admin']), /1 de 1/);
  assert.equal(await f.store.getAccount(f.guild.id, 'ACC-001'), null);
  assert.equal((await f.store.getRecord(f.guild.id, 'vendas', 'VEN-001')).status, 'active', 'the sale now uses the new account');
});

test('startup purge removes posts of accounts deleted before this fix, and nothing else', async () => {
  const f = await setup(() => new Date('2026-10-02T13:00:00Z'));
  for (const login of ['a', 'b']) await f.run('conta', { ferramenta: 'Unlock Tool', login, senha: 'p' }, 'adicionar');
  // Simulates the old behaviour: state forgets the account, its post stays.
  await f.store.transaction(async () => { const state = f.store._current(); delete state.accounts['ACC-001']; });
  await f.freeChannel.send({ content: '**CONTA ACC-001 — DISPONÍVEL**\nmensagem humana', author: { id: 'human' } });
  assert.equal(posted(f.freeChannel).filter(content => content.includes('CONTA ACC-001')).length, 2);
  await f.app.tick(f.guild);
  const remaining = posted(f.freeChannel);
  assert.equal(remaining.filter(content => content.includes('CONTA ACC-001')).length, 1, 'only the bot post is removed');
  assert.ok(remaining.some(content => content.includes('CONTA ACC-002')));
  assert.equal(await f.transport.purgeOrphanAccounts(f.guild), 0);
});

test('commands expose creditos in /vender and the excluir subcommand in /conta', () => {
  const commands = buildCommands().map(command => command.toJSON());
  const sell = commands.find(command => command.name === 'vender');
  const credits = sell.options.find(option => option.name === 'creditos');
  assert.equal(credits.required, false); assert.equal(credits.min_value, 1);
  const remove = commands.find(command => command.name === 'conta').options.find(option => option.name === 'excluir');
  assert.deepEqual(remove.options.map(option => [option.name, option.required]), [['contas', true], ['confirmar', true]]);
});

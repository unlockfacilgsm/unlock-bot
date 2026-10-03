'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MessageFlags } = require('discord.js');
const { BotApp } = require('../src/app');

const GUILD_ID = 'guild';
const NOW = new Date('2026-10-02T15:00:00.000Z');

class FakeStore {
  constructor() {
    this.config = { roles: { adminRoleId: 'admin', sellerRoleId: 'seller' }, channels: { painel: 'panel' } };
    this.calls = [];
    this.rows = { vendas: [], renovacoes: [], trocas: [], vencimentos: [] };
    this.accounts = [];
    this.displayPasswords = new Map();
    this.displayReads = [];
  }
  async getConfig(guild, key, fallback) { return structuredClone(this.config[key] ?? fallback); }
  async setConfig(guild, key, value) { this.config[key] = structuredClone(value); }
  async getRecord(guild, type, id) { return structuredClone(this.rows[type]?.find(row => row.id === id) || null); }
  async getDisplayRecord(guild, type, id) {
    this.displayReads.push({ guild, type, id });
    const record = await this.getRecord(guild, type, id);
    if (record && this.displayPasswords.has(id)) record.password = this.displayPasswords.get(id);
    return record;
  }
  async listRecords(guild, type, { query } = {}) {
    return structuredClone((this.rows[type] || []).filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase())));
  }
  async listAccounts(guild, { tool, query } = {}) {
    return structuredClone(this.accounts.filter(account => (!tool || account.tool === tool) && (!query || JSON.stringify(account).includes(query))));
  }
  async getAccount(guild, id) { return structuredClone(this.accounts.find(account => account.id === id) || null); }
  async createSale(guild, values) {
    this.calls.push({ method: 'createSale', guild, values: structuredClone(values) });
    const sale = { ...values, type: 'vendas', id: 'VEN-001', accountId: values.accountId || 'ACC-001', expiresAt: '2026-10-03T03:00:00.000Z', status: 'active' };
    this.rows.vendas.push(sale);
    return structuredClone(sale);
  }
  async renewSale(guild, values) {
    this.calls.push({ method: 'renewSale', guild, values: structuredClone(values) });
    const sale = this.rows.vendas.find(row => row.id === values.saleId);
    const renewal = { ...values, id: 'REN-001', type: 'renovacoes', tool: sale.tool, client: sale.client, expiresAt: '2027-01-02T15:00:00.000Z' };
    sale.currentPlan = values.plan;
    sale.expiresAt = renewal.expiresAt;
    this.rows.renovacoes.push(renewal);
    return structuredClone(renewal);
  }
  async upsertAccount(guild, values) {
    this.calls.push({ method: 'upsertAccount', guild, values: structuredClone(values) });
    return { ...values, id: 'ACC-001' };
  }
  async updateAccountPassword(guild, values) {
    this.calls.push({ method: 'updateAccountPassword', guild, values: structuredClone(values) });
    return { id: values.accountId };
  }
  async expireSales(guild, at) { this.calls.push({ method: 'expireSales', guild, at }); }
  async updatePassword(guild, values) { this.calls.push({ method: 'updatePassword', guild, values: structuredClone(values) }); }
  async createTrade(guild, values) {
    this.calls.push({ method: 'createTrade', guild, values: structuredClone(values) });
    return { ...values, id: 'TRC-001', type: 'trocas' };
  }
  async releaseAccounts(guild, values) {
    this.calls.push({ method: 'releaseAccounts', guild, values: structuredClone(values) });
    return { changed: [], errors: [] };
  }
  async listAudit() { return []; }
  async listOutbox() { return []; }
}

function interaction(commandName, values = {}, settings = {}) {
  const replies = [];
  const collector = new EventEmitter();
  collector.stop = reason => collector.emit('end', [], reason);
  const result = {
    commandName, guild: { id: settings.guildId || GUILD_ID }, channelId: settings.channelId || 'panel',
    user: { id: 'operator' }, member: { roles: settings.roles ?? ['seller'] },
    memberPermissions: { has: () => settings.manageGuild === true },
    replied: false, deferred: false, responded: false, replies, collector, fetchCount: 0,
    options: {
      getFocused: () => ({ name: settings.focusedName || 'plano', value: settings.focusedValue || '' }),
      getSubcommand: () => settings.subcommand
    },
    isAutocomplete: () => Boolean(settings.autocomplete),
    isChatInputCommand: () => !settings.autocomplete,
    async deferReply(payload) { this.deferred = true; this.deferPayload = payload; },
    async editReply(payload) {
      assert.ok(!payload.content || payload.content.length <= 2000, 'Resposta excede o limite do Discord');
      replies.push(payload);
    },
    async reply(payload) { this.replied = true; replies.push(payload); },
    async respond(choices) { this.responded = true; this.choices = choices; },
    async fetchReply() {
      this.fetchCount++;
      return { createMessageComponentCollector: options => { this.collectorOptions = options; return collector; } };
    }
  };
  for (const type of ['String', 'Number', 'Integer', 'Boolean', 'Role', 'Attachment']) {
    result.options[`get${type}`] = name => Object.hasOwn(values, name) ? values[name] : null;
  }
  return result;
}

function harness() {
  const store = new FakeStore();
  const transport = {
    flushCalls: 0, setupCalls: [], backupCalls: 0,
    async flush() { this.flushCalls++; return { errors: [] }; },
    async setup(guild, roles) { this.setupCalls.push({ guild, roles }); },
    async backup() { this.backupCalls++; return { url: 'https://discord.com/channels/guild/backups/1' }; },
    async reminders() {}
  };
  const logger = { messages: [], error(value) { this.messages.push(value); } };
  const app = new BotApp({ client: { user: { id: 'bot' } }, store, transport, guildId: GUILD_ID,
    clock: () => NOW, logger, migrate: async () => ({ imported: 1, errors: [], conflicts: [] }) });
  return { store, transport, app, logger };
}

function content(value) { return value.replies.map(reply => reply.content || '').join('\n'); }
function manual(extra = {}) {
  return { cliente: 'Cliente', ferramenta: 'Unlock Tool', plano: '12 horas', login: 'account@example.com', senha: '  secret$&`  ', ...extra };
}

test('/vencidas delivers exact combolist credentials privately with the existing tool filter', async () => {
  const { app, store } = harness();
  store.rows.vencimentos.push(
    { id: 'VENC-001', tool: 'AMT Tool', login: 'one@example.com', status: 'pending' },
    { id: 'VENC-002', tool: 'AMT Tool', login: 'two', status: 'pending' },
    { id: 'VENC-003', tool: 'TSM Tool', login: 'other', status: 'pending' },
    { id: 'VENC-004', tool: 'AMT Tool', login: 'done', status: 'completed' }
  );
  store.displayPasswords.set('VENC-001', '  $&`*:senha  ');
  store.displayPasswords.set('VENC-002', 'á123');
  const request = interaction('vencidas', { ferramenta: 'AMT Tool' });
  await app.handle(request);
  assert.equal(request.deferPayload.flags, MessageFlags.Ephemeral);
  assert.equal(request.replies[0].files[0].name, 'vencidas.txt');
  assert.equal(request.replies[0].files[0].attachment.toString('utf8'), 'one@example.com:  $&`*:senha  \ntwo:á123');
  const denied = interaction('vencidas', {}, { roles: [] });
  const reads = store.displayReads.length;
  await app.handle(denied);
  assert.equal(store.displayReads.length, reads);
  assert.ok(!denied.replies.some(reply => reply.files));
  store.displayPasswords.delete('VENC-002');
  const missing = interaction('vencidas', { ferramenta: 'AMT Tool' });
  await app.handle(missing);
  assert.match(content(missing), /VENC-002/);
  assert.ok(!missing.replies.some(reply => reply.files));
});

test('authorized sales queries show passwords inside separators without exposing them to strangers or CSV', async () => {
  const { app, store } = harness();
  store.rows.vendas.push({ id: 'VEN-019', type: 'vendas', tool: 'AMT Tool', login: 'LOGIN', client: 'Cliente', plan: '1 mês', priceCents: 3000 });
  store.displayPasswords.set('VEN-019', 'private-sale-password');
  for (const name of ['ver', 'listar', 'buscar']) {
    const request = interaction(name, { tipo: 'vendas', id: 'VEN-019', termo: 'LOGIN' });
    await app.handle(request);
    assert.match(content(request), /Senha: private-sale-password/);
    assert.match(content(request), /-----------------------------------------/);
  }
  const count = store.displayReads.length;
  const denied = interaction('ver', { tipo: 'vendas', id: 'VEN-019' }, { roles: [] });
  await app.handle(denied);
  assert.ok(!content(denied).includes('private-sale-password'));
  assert.equal(store.displayReads.length, count);
  const csv = interaction('exportar', { tipo: 'vendas' });
  await app.handle(csv);
  assert.ok(!csv.replies.flatMap(reply => reply.files || []).some(file => file.attachment.toString().includes('private-sale-password')));
});

test('autorização nega desconhecidos, servidor diferente e comando administrativo a vendedor', async () => {
  for (const settings of [{ roles: [] }, { guildId: 'other' }]) {
    const { app, store, transport } = harness();
    const command = interaction('vender', manual(), settings);
    await app.handle(command);
    assert.match(content(command), /cargo não está autorizado/);
    assert.equal(store.calls.length, 0);
    assert.equal(transport.flushCalls, 0);
  }
  const { app, transport } = harness();
  const adminCommand = interaction('backup');
  await app.handle(adminCommand);
  assert.match(content(adminCommand), /cargo não está autorizado/);
  assert.equal(transport.backupCalls, 0);
});

test('cargo administrador e Gerenciar servidor autorizam sem cargo vendedor', async () => {
  for (const settings of [{ roles: ['admin'] }, { roles: [], manageGuild: true }]) {
    const { app, transport } = harness();
    const command = interaction('configurar', { administrador: { id: 'admin' }, vendedor: { id: 'seller' } }, { ...settings, channelId: 'outside' });
    await app.handle(command);
    assert.equal(transport.setupCalls.length, 1);
    assert.deepEqual(transport.setupCalls[0].roles, { adminRoleId: 'admin', sellerRoleId: 'seller', actorId: 'operator' });
    assert.match(content(command), /configurada/);
  }
});

test('/configurar rejeita @everyone em qualquer campo com orientação para criar cargo', async () => {
  for (const field of ['administrador', 'vendedor']) {
    const { app, transport } = harness();
    const command = interaction('configurar', { [field]: { id: GUILD_ID, name: '@everyone' } }, { manageGuild: true });
    await app.handle(command);
    assert.equal(transport.setupCalls.length, 0);
    assert.match(content(command), /Não use @everyone/);
    assert.match(content(command), /Crie um cargo/);
    assert.match(content(command), /cargos, não seu @ de usuário/);
    assert.deepEqual(command.replies[0].allowedMentions, { parse: [] });
  }
});

test('/configurar recusa cargos de integração do bot como cargos da equipe', async () => {
  for (const field of ['administrador', 'vendedor']) {
    const { app, transport } = harness();
    const command = interaction('configurar', { [field]: { id: 'bot-role', name: 'Unlock Fácil', managed: true } }, { manageGuild: true });
    await app.handle(command);
    assert.equal(transport.setupCalls.length, 0);
    assert.match(content(command), /gerenciado por uma integração ou bot/);
    assert.match(content(command), /cargo da equipe/);
    assert.match(content(command), /bot já recebe acesso pela própria conta/);
  }
});

test('/configurar recusa também cargo de integração salvo na configuração', async () => {
  const { app, store, transport } = harness();
  store.config.roles = { adminRoleId: 'bot-role', sellerRoleId: null };
  const command = interaction('configurar', {}, { roles: [], manageGuild: true });
  command.guild.roles = { cache: new Map([['bot-role', { id: 'bot-role', name: 'Unlock Fácil', managed: true }]]) };
  await app.handle(command);
  assert.equal(transport.setupCalls.length, 0);
  assert.match(content(command), /gerenciado por uma integração ou bot/);
});

test('/configurar explica os cargos e o acesso do bot; proprietário pode configurar sem cargo adicional', async () => {
  const { app, store, transport } = harness();
  store.config.roles = {};
  const command = interaction('configurar', {}, { roles: [], manageGuild: true });
  await app.handle(command);
  assert.equal(transport.setupCalls.length, 1);
  assert.match(content(command), /pessoas com Gerenciar servidor/);
  assert.match(content(command), /Vendedor: nenhum cargo definido/);
  assert.match(content(command), /bot usa o próprio acesso/);
  assert.match(content(command), /<#panel>/);
  assert.deepEqual(command.replies[0].allowedMentions, { parse: [] });
});

test('/configurar permite um mesmo cargo humano para administrador e vendedor', async () => {
  const { app, transport } = harness();
  const role = { id: 'team', name: 'Administração', managed: false };
  const command = interaction('configurar', { administrador: role, vendedor: role }, { manageGuild: true });
  await app.handle(command);
  assert.deepEqual(transport.setupCalls[0].roles, { adminRoleId: 'team', sellerRoleId: 'team', actorId: 'operator' });
  assert.match(content(command), /Administrador: <@&team>/);
});

test('erro 50013 na configuração orienta permissões e registra diagnóstico seguro', async () => {
  const { app, transport, logger } = harness();
  transport.setup = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
  const command = interaction('configurar', { administrador: { id: 'admin' } }, { manageGuild: true });
  await app.handle(command);
  assert.match(content(command), /Gerenciar cargos/);
  assert.match(content(command), /Gerenciar canais/);
  assert.match(logger.messages.join('\n'), /50013/);
  assert.match(logger.messages.join('\n'), /Missing Permissions|Gerenciar/);
});

test('vendedor opera apenas no painel e a resposta é efêmera', async () => {
  const { app, store } = harness();
  const command = interaction('vender', manual(), { channelId: 'public' });
  await app.handle(command);
  assert.match(content(command), /canal de painel/);
  assert.equal(store.calls.length, 0);
  assert.equal(command.deferPayload.flags, MessageFlags.Ephemeral);
});

test('autocomplete mostra preço apenas dos planos da ferramenta e bloqueia acesso sem cargo', async () => {
  const { app } = harness();
  const unlock = interaction('vender', { ferramenta: 'Unlock Tool' }, { autocomplete: true, focusedValue: '12' });
  await app.handle(unlock);
  assert.deepEqual(unlock.choices.map(choice => choice.value), ['12 horas', '12 meses']);
  assert.match(unlock.choices[0].name, /10,00/);

  const borneo = interaction('vender', { ferramenta: 'Borneo Schematics' }, { autocomplete: true });
  await app.handle(borneo);
  assert.deepEqual(borneo.choices.map(choice => choice.value), ['3 dias', '1 mês', '3 meses', '12 meses']);
  assert.match(borneo.choices[0].name, /20,00/);

  const denied = interaction('vender', { ferramenta: 'Unlock Tool' }, { autocomplete: true, roles: [] });
  await app.handle(denied);
  assert.deepEqual(denied.choices, []);
});

test('autocomplete de renovação deriva a ferramenta do ID da venda', async () => {
  const { app, store } = harness();
  store.rows.vendas.push({ id: 'VEN-003', tool: 'TFM Tool' });
  const command = interaction('renovar', { venda: ' ven-003 ' }, { autocomplete: true });
  await app.handle(command);
  assert.deepEqual(command.choices.map(choice => choice.value), ['12 horas', '3 meses']);
  assert.match(command.choices[0].name, /20,00/);
  const unknown = interaction('renovar', { venda: 'VEN-999' }, { autocomplete: true });
  await app.handle(unknown);
  assert.deepEqual(unknown.choices, []);
});

test('venda manual preserva senha exata e registra centavos, desconto e responsável', async () => {
  const { app, store, logger } = harness();
  const password = '  secret$&`  ';
  const command = interaction('vender', manual({ senha: password, valor: 55, desconto: 5 }));
  await app.handle(command);
  const call = store.calls.find(value => value.method === 'createSale');
  assert.ok(call);
  assert.equal(call.values.password, password);
  assert.equal(call.values.priceCents, 5000);
  assert.equal(call.values.discountCents, 500);
  assert.equal(call.values.actorId, 'operator');
  assert.equal(call.values.registeredAt, NOW.toISOString());
  assert.match(content(command), /50,00/);
  assert.equal(content(command).includes(password), false);
  assert.equal(logger.messages.join(' ').includes(password), false);
});

test('venda por conta não envia credenciais manuais e ambas as alternativas são exclusivas', async () => {
  const { app, store } = harness();
  const command = interaction('vender', { cliente: 'Cliente', ferramenta: 'TSM Tool', plano: '12 horas', conta: 'acc-003' });
  await app.handle(command);
  const call = store.calls.find(value => value.method === 'createSale');
  assert.equal(call.values.accountId, 'ACC-003');
  assert.equal(call.values.priceCents, 2000);
  assert.equal(Object.hasOwn(call.values, 'login'), false);
  assert.equal(Object.hasOwn(call.values, 'password'), false);

  for (const values of [manual({ conta: 'ACC-001' }), { ...manual(), senha: null }, { ...manual(), login: null }]) {
    const setup = harness();
    const invalid = interaction('vender', values);
    await setup.app.handle(invalid);
    assert.match(content(invalid), /❌/);
    assert.equal(setup.store.calls.length, 0);
  }
});

test('ferramenta, plano e valores inválidos são recusados antes de qualquer gravação', async () => {
  for (const fields of [
    { ferramenta: 'Invalid' }, { ferramenta: 'Borneo Schematics', plano: '12 horas' },
    { ferramenta: 'TFM Tool', plano: '12 meses' }, { valor: -1 }, { valor: 1.001 },
    { desconto: 11 }, { cliente: 'Nome\nSenha: injetada' }
  ]) {
    const { app, store, transport } = harness();
    const command = interaction('vender', manual(fields));
    await app.handle(command);
    assert.match(content(command), /❌/);
    assert.equal(store.calls.length, 0, JSON.stringify(fields));
    assert.equal(transport.flushCalls, 0);
  }
});

test('trocas de senha exigem confirmação true antes de atualizar ou vencer contas', async () => {
  for (const name of ['troca-senha', 'trocar-senhas', 'conta']) {
    for (const confirmada of [null, false]) {
      const { app, store } = harness();
      const command = interaction(name, { confirmada, vencimento: 'VENC-001', vencimentos: 'VENC-001', conta: 'ACC-001', nova_senha: 'new$&' }, { subcommand: 'senha' });
      await app.handle(command);
      assert.match(content(command), /Confirme a troca/);
      assert.equal(store.calls.length, 0);
    }
  }
});

test('troca individual mantém vínculo e lote aceita IDs deduplicados com senha exata', async () => {
  const { app, store } = harness();
  const password = ' $&  ';
  const individual = interaction('troca-senha', { vencimento: 'VENC-001', nova_senha: password, confirmada: true });
  await app.handle(individual);
  assert.equal(store.calls.find(call => call.method === 'updatePassword').values.newPassword, password);
  assert.match(content(individual), /continua vinculada/);
  assert.equal(store.calls.some(call => call.method === 'releaseAccounts'), false);

  const batch = interaction('trocar-senhas', { vencimentos: 'VENC-001, venc-001, VENC-002', nova_senha: password, confirmada: true });
  await app.handle(batch);
  const released = store.calls.find(call => call.method === 'releaseAccounts');
  assert.deepEqual(released.values.expirationIds, ['VENC-001', 'VENC-002']);
  assert.equal(released.values.newPassword, password);
});

test('renovação registra receita própria e o painel soma os valores históricos imutáveis', async () => {
  const { app, store } = harness();
  store.rows.vendas.push({ id: 'VEN-001', type: 'vendas', client: 'Cliente', tool: 'Unlock Tool', plan: '12 horas', priceCents: 1000,
    registeredAt: NOW.toISOString(), expiresAt: '2026-10-03T03:00:00.000Z', status: 'active' });
  const command = interaction('renovar', { venda: 'VEN-001', plano: '3 meses', desconto: 5 });
  await app.handle(command);
  const original = store.rows.vendas[0];
  assert.equal(original.plan, '12 horas');
  assert.equal(original.priceCents, 1000);
  assert.equal(store.rows.renovacoes[0].priceCents, 5000);
  assert.equal(store.rows.renovacoes[0].saleId, 'VEN-001');
  const panel = interaction('painel');
  await app.handle(panel);
  assert.match(content(panel), /Hoje: 2 operação\(ões\).*60,00/);
});

test('migração obrigatória bloqueia novas operações e migração concluída desbloqueia', async () => {
  const { app, store } = harness();
  store.config.migrationRequired = true;
  const sale = interaction('vender', manual());
  await app.handle(sale);
  assert.match(content(sale), /Importe o histórico/);
  assert.equal(store.calls.length, 0);

  const migration = interaction('migrar', {}, { roles: ['admin'], channelId: 'outside' });
  await app.handle(migration);
  assert.equal(store.config.migrationRequired, false);
  assert.equal(store.config.migrationCompleted, true);
  await app.handle(interaction('vender', manual()));
  assert.equal(store.calls.some(call => call.method === 'createSale'), true);
});

test('CSV de contas omite segredos e impede fórmulas de planilha', async () => {
  const { app, store } = harness();
  store.accounts.push({ id: 'ACC-001', tool: 'Unlock Tool', login: '=HYPERLINK("evil")', status: 'available',
    registeredAt: NOW.toISOString(), password: 'DO_NOT_EXPORT$&', passwordEncrypted: 'CIPHER_DO_NOT_EXPORT' });
  const command = interaction('exportar', { tipo: 'contas', inicio: '02/10/2026', fim: '02/10/2026' });
  await app.handle(command);
  const csv = command.replies[0].files[0].attachment.toString('utf8');
  assert.match(csv, /ACC-001/);
  assert.match(csv, /'=HYPERLINK/);
  assert.equal(csv.includes('DO_NOT_EXPORT'), false);
  assert.equal(csv.includes('password'), false);
  assert.match(content(command), /1 registro/);
});

test('falha de publicação informa que a venda foi registrada e não expõe a senha', async () => {
  for (const failure of [async () => { throw new Error('Discord unavailable'); }, async () => ({ errors: [{ id: 'pending' }] })]) {
    const { app, store, transport } = harness();
    transport.flush = failure;
    const command = interaction('vender', manual());
    await app.handle(command);
    assert.equal(store.rows.vendas.length, 1);
    assert.match(content(command), /Venda.*VEN-001.*registrada/s);
    assert.match(content(command), /pendente|pendentes/);
    assert.equal(content(command).includes(manual().senha), false);
  }
});

test('consultas longas usam páginas privadas e não revelam senha de contas', async () => {
  const { app, store } = harness();
  store.accounts = Array.from({ length: 100 }, (_, index) => ({ id: `ACC-${index + 1}`, tool: 'Unlock Tool', login: `login-${index}`, status: 'available', password: 'DO_NOT_RENDER' }));
  const command = interaction('conta', {}, { subcommand: 'listar' });
  await app.handle(command);
  assert.ok(command.fetchCount > 0);
  assert.match(content(command), /Página 1\/100/);
  assert.equal(content(command).includes('DO_NOT_RENDER'), false);
  assert.equal(command.replies[0].components[0].components.length, 2);
});

test('restauração recusa anexo fora do Discord antes de fazer requisição', async () => {
  const { app } = harness();
  const command = interaction('restaurar', { confirmada: true, arquivo: { size: 200, url: 'http://localhost:1234/private' } }, { roles: ['admin'] });
  await app.handle(command);
  assert.match(content(command), /anexo do Discord/);
});

test('troca recusa ferramenta inválida antes de gravar o registro', async () => {
  const { app, store } = harness();
  const command = interaction('troca', { cliente: 'Cliente', ferramenta: 'Invalid', motivo: 'Erro' });
  await app.handle(command);
  assert.match(content(command), /Ferramenta inválida/);
  assert.equal(store.calls.length, 0);
});

test('busca e exportação sem filtro incluem contas ainda disponíveis no estoque', async () => {
  const { app, store } = harness();
  store.accounts.push({ id: 'ACC-001', tool: 'Unlock Tool', login: 'unique-stock-login', status: 'available', registeredAt: NOW.toISOString(), password: 'HIDDEN_STOCK_PASSWORD' });
  const search = interaction('buscar', { termo: 'unique-stock-login', tipo: 'tudo' });
  await app.handle(search);
  assert.match(content(search), /ACC-001/);
  assert.equal(content(search).includes('HIDDEN_STOCK_PASSWORD'), false);
  const exporting = interaction('exportar');
  await app.handle(exporting);
  const csv = exporting.replies[0].files[0].attachment.toString('utf8');
  assert.match(csv, /ACC-001/);
  assert.equal(csv.includes('HIDDEN_STOCK_PASSWORD'), false);
});

test('conta listar continua disponível enquanto a migração bloqueia novas operações', async () => {
  const { app, store } = harness();
  store.config.migrationRequired = true;
  store.accounts.push({ id: 'ACC-001', tool: 'Unlock Tool', login: 'legacy-account', status: 'available' });
  const command = interaction('conta', {}, { subcommand: 'listar' });
  await app.handle(command);
  assert.match(content(command), /ACC-001/);
  assert.equal(store.calls.length, 0);
});

test('migração com erro mantém o bloqueio de novas vendas', async () => {
  const { app, store } = harness();
  store.config.migrationRequired = true;
  app.migrate = async () => ({ imported: 1, errors: ['channel-unavailable'], conflicts: [] });
  const command = interaction('migrar', {}, { roles: ['admin'] });
  await app.handle(command);
  assert.equal(store.config.migrationRequired, true);
  assert.notEqual(store.config.migrationCompleted, true);
});

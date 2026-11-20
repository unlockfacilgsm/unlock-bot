'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { planSync } = require('../src/account-sync');

const GUILD = 'guild-1';

function memoryStore() {
  const messages = new Map(), downloads = new Map();
  let nextId = 0;
  const channel = {
    id: 'data', guildId: GUILD, client: { user: { id: 'bot' } },
    messages: { async fetch({ limit = 100, before } = {}) {
      return new Map([...messages.values()].filter((m) => !before || BigInt(m.id) < BigInt(before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, limit).map((m) => [m.id, m]));
    } },
    async send(options) {
      const id = String(++nextId); const attachments = new Map();
      for (const [i, f] of (options.files || []).entries()) { const url = `mem://${id}/${i}`; downloads.set(url, Buffer.from(f.attachment)); attachments.set(String(i), { name: f.name, url }); }
      const m = { id, author: { id: 'bot' }, content: options.content, attachments, createdTimestamp: nextId };
      messages.set(id, m); return m;
    },
  };
  return new Store({ channel, guildId: GUILD, encryptionKey: Buffer.alloc(32, 7), downloadAttachment: async (url) => downloads.get(url) });
}

const bot = (o) => ({ id: 'ACC-1', tool: 'Unlock Tool', login: 'conta1', password: 'p1', status: 'available', activeSaleId: null, updatedAt: '2026-11-01T00:00:00Z', ...o });
const site = (o) => ({ id: 10, tool_id: 'unlocktool', login: 'conta1', password: 'p1', status: 'available', order_id: null, reserved_order_id: null, sync_locked: false, last_check_status: null, last_check_at: null, created_at: '2026-10-01T00:00:00Z', ...o });

test('conta só de um lado aparece no outro', () => {
  let p = planSync([bot()], []);
  assert.deepEqual(p.siteOps[0], { op: 'insert', toolId: 'unlocktool', login: 'conta1', password: 'p1', status: 'available' });
  p = planSync([bot({ status: 'occupied', activeSaleId: 'VEN-9' })], []);
  assert.equal(p.siteOps[0].status, 'sold');
  p = planSync([], [site()]);
  assert.deepEqual(p.botOps[0], { op: 'add', tool: 'Unlock Tool', login: 'conta1', password: 'p1', status: 'available' });
  p = planSync([], [site({ status: 'sold', order_id: 77 })]);
  assert.equal(p.botOps[0].status, 'occupied');
  p = planSync([], [site({ status: 'sold' })]);   // vendida antes da sincronia: em uso no site
  assert.equal(p.botOps[0].status, 'occupied');
  assert.equal(planSync([], [site({ status: 'unavailable' })]).botOps.length, 0, 'reprovada não entra no Discord');
  assert.deepEqual(planSync([], [site({ status: 'sold', sync_locked: true })]).siteOps[0].op, 'kill', 'travada pela sincronia e apagada no Discord');
  assert.equal(planSync([bot({ tool: 'AMT Tool' })], []).siteOps.length, 0, 'AMT fica fora');
});

test('em uso de um lado trava o outro, sem venda dupla', () => {
  let p = planSync([bot({ status: 'occupied', activeSaleId: 'VEN-1' })], [site()]);
  assert.deepEqual(p.siteOps[0], { op: 'lock', id: 10, why: 'em uso no Discord (VEN-1)' });
  p = planSync([bot({ status: 'occupied', needsPasswordReset: true })], [site()]);
  assert.equal(p.siteOps[0].op, 'lock');
  p = planSync([bot()], [site({ status: 'sold', order_id: 5 })]);
  assert.deepEqual(p.botOps[0], { op: 'update', accountId: 'ACC-1', status: 'occupied' });
  p = planSync([bot()], [site({ status: 'reserved', reserved_order_id: 6 })]);
  assert.equal(p.botOps[0].status, 'occupied');
  p = planSync([bot({ status: 'occupied', activeSaleId: 'VEN-1' })], [site({ status: 'sold', order_id: 5 })]);
  assert.equal(p.conflicts.length, 1, 'vendida nos dois lados vira alerta');
  assert.equal(p.botOps.length + p.siteOps.length, 0);
});

test('liberação de um lado libera o outro', () => {
  let p = planSync([bot()], [site({ status: 'sold', sync_locked: true })]);
  assert.deepEqual(p.siteOps[0], { op: 'free', id: 10, password: null });
  p = planSync([bot({ status: 'occupied', syncLocked: true })], [site()]);
  assert.deepEqual(p.botOps[0], { op: 'update', accountId: 'ACC-1', status: 'available' });
  p = planSync([bot({ password: 'nova', updatedAt: '2026-11-13T00:00:00Z' })], [site({ status: 'sold', sync_locked: true, last_check_status: 'VALID', last_check_at: '2026-11-12T00:00:00Z' })]);
  assert.deepEqual(p.siteOps[0], { op: 'free', id: 10, password: 'nova' }, 'Discord trocou a senha ao liberar');
});

test('registro antigo da migração (vendida sem pedido): o Discord decide', () => {
  let p = planSync([bot({ status: 'occupied', activeSaleId: 'VEN-5' })], [site({ status: 'sold' })]);
  assert.equal(p.conflicts.length, 0, 'mesma venda, não é venda dupla');
  assert.deepEqual(p.siteOps, [{ op: 'adopt', id: 10, password: null }]);
  p = planSync([bot({ password: 'atual' })], [site({ status: 'sold', password: 'antiga' })]);
  assert.deepEqual(p.siteOps, [{ op: 'freeLegacy', id: 10, password: 'atual' }], 'livre no Discord → livre no site');
  p = planSync([bot({ status: 'occupied', syncLocked: true })], [site({ status: 'sold' })]);
  assert.equal(p.botOps.length + p.siteOps.length, 0, 'sem dono claro: nada muda');
  p = planSync([bot({ status: 'occupied', syncLocked: true })], [site({ status: 'sold', sync_locked: true })]);
  assert.equal(p.botOps.length + p.siteOps.length, 0, 'travada dos dois lados não libera sozinha');
});

test('reprovada no site sai do Discord, mas nunca de uma venda ativa', () => {
  assert.deepEqual(planSync([bot()], [site({ status: 'unavailable', last_check_status: 'INVALID' })]).botOps[0],
    { op: 'remove', accountId: 'ACC-1', reason: 'reprovada pelo checador do site (INVALID)' });
  assert.equal(planSync([bot({ status: 'occupied', activeSaleId: 'VEN-1' })], [site({ status: 'unavailable' })]).botOps.length, 0);
});

test('senha diferente: vale a validada; sem validação, a mais recente', () => {
  let p = planSync([bot({ password: 'velha' })], [site({ password: 'boa', last_check_status: 'VALID', last_check_at: '2026-11-12T00:00:00Z' })]);
  assert.deepEqual(p.botOps[0], { op: 'update', accountId: 'ACC-1', status: 'available', password: 'boa' });
  p = planSync([bot({ password: 'nova', updatedAt: '2026-11-13T00:00:00Z' })], [site({ password: 'velha' })]);
  assert.deepEqual(p.siteOps[0], { op: 'password', id: 10, password: 'nova' });
  p = planSync([bot({ password: 'nova', updatedAt: '2026-11-13T00:00:00Z' })], [site({ password: 'velha', last_check_status: 'INVALID', last_check_at: '2026-11-12T00:00:00Z' })]);
  assert.equal(p.siteOps[0].password, 'nova', 'senha reprovada no site não vence');
  p = planSync([bot({ status: 'occupied', activeSaleId: 'VEN-1', password: 'entregue' })], [site({ status: 'sold', sync_locked: true, password: 'outra' })]);
  assert.deepEqual(p.siteOps, [{ op: 'password', id: 10, password: 'entregue' }], 'conta em uso no Discord: site segue o Discord');
  assert.equal(planSync([bot({ login: ' Conta1 ' })], [site()]).botOps.length + planSync([bot({ login: ' Conta1 ' })], [site()]).siteOps.length, 0, 'login compara sem espaço/maiúscula');
});

test('store.syncAccounts aplica tudo num evento e não toca conta em venda', async () => {
  const store = memoryStore(); await store.load();
  const sold = await store.createSale(GUILD, { client: 'C', tool: 'Unlock Tool', plan: '12 horas', login: 'vendida', password: 'x1', priceCents: 1000, discountCents: 0, registeredAt: '2026-11-13T10:00:00Z' });
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  const before = store._sequence;
  const results = await store.syncAccounts(GUILD, [
    { op: 'add', tool: 'Unlock Tool', login: 'nova', password: 'n1', status: 'available' },
    { op: 'add', tool: 'TSM Tool', login: 'travada', password: 't1', status: 'occupied' },
    { op: 'add', tool: 'Unlock Tool', login: 'VENDIDA', password: 'zz', status: 'available' },
    { op: 'update', accountId: sold.accountId, status: 'available', password: 'mudou' },
    { op: 'remove', accountId: sold.accountId },
  ]);
  assert.equal(store._sequence, before + 1, 'um único evento no Discord');
  assert.equal(results[2].skipped, 'já existe');
  assert.equal(results[3].skipped, 'em uso no Discord');
  assert.equal(results[4].skipped, 'em uso no Discord');
  const accounts = await store.listAccounts(GUILD);
  const locked = accounts.find((a) => a.login === 'travada');
  assert.equal(locked.status, 'occupied'); assert.equal(locked.syncLocked, true);
  assert.equal(accounts.find((a) => a.login === 'vendida').password, 'x1');
  const nova = accounts.find((a) => a.login === 'nova');
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  await store.syncAccounts(GUILD, [{ op: 'update', accountId: locked.id, status: 'available' }, { op: 'remove', accountId: nova.id, reason: 'reprovada' }]);
  const after = await store.listAccounts(GUILD);
  assert.equal(after.find((a) => a.login === 'travada').status, 'available');
  assert.equal(after.find((a) => a.login === 'travada').syncLocked, false);
  assert.equal(after.some((a) => a.login === 'nova'), false);
  // Recarregar do "Discord" reconstrói o mesmo estado.
  const reloaded = new Store({ channel: store.channel, guildId: GUILD, encryptionKey: Buffer.alloc(32, 7), downloadAttachment: store.downloadAttachment });
  await reloaded.load();
  assert.deepEqual((await reloaded.listAccounts(GUILD)).map((a) => [a.login, a.status]).sort(), after.map((a) => [a.login, a.status]).sort());
});

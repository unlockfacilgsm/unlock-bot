'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planExpiry, isAmt12h } = require('../src/expiry-rotation');
const { planSync } = require('../src/account-sync');

const VENC_AT = '2026-11-13T10:00:00.000Z';
const venc = (id, tool, saleId) => ({ id, tool, saleId, status: 'pending', registeredAt: VENC_AT });
const sale = (id, accountId, plan) => ({ id, accountId, plan, status: 'expired' });
const acc = (id, tool, login, password, saleId) => ({ id, tool, login, password, activeSaleId: saleId, status: 'occupied' });
const row = (id, login, password, extra = {}) => ({ id, tool_id: 'unlocktool', login, password, status: 'sold', order_id: null, reserved_order_id: null, rotate_requested_at: null, last_rotate_at: null, last_rotate_status: null, ...extra });

function setup(siteRow, { tool = 'Unlock Tool', plan = '12 horas', password = 'old1' } = {}) {
  const pending = [venc('VENC-1', tool, 'VEN-1')];
  const sales = new Map([['VEN-1', sale('VEN-1', 'ACC-1', plan)]]);
  const accounts = new Map([['ACC-1', acc('ACC-1', tool, 'joao', password, 'VEN-1')]]);
  const site = new Map(siteRow ? [['unlocktool|joao', siteRow]] : []);
  return { pending, sales, accounts, site };
}

test('AMT 12 horas volta ao estoque sem troca; planos maiores e TSM não', () => {
  assert.equal(isAmt12h('AMT Tool', '12 horas'), true);
  assert.equal(isAmt12h('AMT Tool', '1 mês'), false);
  assert.equal(isAmt12h('TSM Tool', '12 horas'), false);
  const p = planExpiry(setup(null, { tool: 'AMT Tool' }));
  assert.deepEqual(p.releaseAmt.map(r => [r.id, r.password]), [['VENC-1', 'old1']]);
  assert.equal(planExpiry(setup(null, { tool: 'AMT Tool', plan: '1 mês' })).releaseAmt.length, 0);
  const tsm = planExpiry(setup(null, { tool: 'TSM Tool' }));
  assert.equal(tsm.releaseAmt.length + tsm.requestRotate.length, 0);
});

test('Unlock Tool vencida no Discord pede a troca ao trocador uma vez', () => {
  const p = planExpiry(setup(row(10, 'joao', 'old1', { sync_locked: true })));
  assert.deepEqual(p.requestRotate.map(r => r.siteId), [10]);
  assert.ok(p.inFlight.has('unlocktool|joao'));
  // já pedida há pouco (o trocador zera rotate_requested_at ao pegar): não pede de novo
  const again = planExpiry({ ...setup(row(10, 'joao', 'old1')), requested: new Map([['10', Date.now() - 60_000]]) });
  assert.equal(again.requestRotate.length, 0);
  assert.ok(again.inFlight.has('unlocktool|joao'));
  // na fila
  assert.equal(planExpiry(setup(row(10, 'joao', 'old1', { rotate_requested_at: new Date() }))).requestRotate.length, 0);
});

test('não pede troca se a senha do site difere ou se a conta está num pedido do site', () => {
  assert.equal(planExpiry(setup(row(10, 'joao', 'outra'))).requestRotate.length, 0);
  assert.equal(planExpiry(setup(row(10, 'joao', 'old1', { order_id: 5 }))).requestRotate.length, 0);
});

test('trocada pelo trocador depois do vencimento: libera no Discord com a senha nova', () => {
  const p = planExpiry(setup(row(10, 'joao', 'Unlockfacil1234', { status: 'available', last_rotate_status: 'RECYCLED', last_rotate_at: '2026-11-14T06:00:00Z' })));
  assert.deepEqual(p.releaseRotated.map(r => [r.id, r.password]), [['VENC-1', 'Unlockfacil1234']]);
});

test('reciclo antigo (antes do vencimento) não conta como troca; falha fica para o manual', () => {
  const old = planExpiry(setup(row(10, 'joao', 'old1', { last_rotate_status: 'RECYCLED', last_rotate_at: '2026-11-01T00:00:00Z' })));
  assert.equal(old.releaseRotated.length, 0);
  assert.equal(old.requestRotate.length, 1);
  const failed = planExpiry(setup(row(10, 'joao', 'old1', { status: 'unavailable', last_rotate_status: 'WRONG_PASSWORD', last_rotate_at: '2026-11-14T06:00:00Z' })));
  assert.deepEqual(failed.failed.map(f => f.id), ['VENC-1']);
  assert.equal(failed.requestRotate.length, 0);
});

test('a sincronia de contas não mexe em conta em troca automática', () => {
  const bot = [{ id: 'ACC-1', tool: 'Unlock Tool', login: 'joao', password: 'old1', activeSaleId: 'VEN-1', status: 'occupied' }];
  const site = [{ id: 10, tool_id: 'unlocktool', login: 'joao', password: 'Unlockfacil1234', status: 'available', last_rotate_at: '2026-11-14T06:00:00Z' }];
  assert.ok(planSync(bot, site).siteOps.length > 0);   // sem o skip ela travaria e voltaria a senha antiga
  const skipped = planSync(bot, site, new Set(['unlocktool|joao']));
  assert.equal(skipped.siteOps.length + skipped.botOps.length, 0);
});

test('senha trocada pelo site depois da última mudança no Discord: a do site vence (caso #281)', () => {
  const bot = [{ id: 'ACC-1', tool: 'Unlock Tool', login: 'joao', password: 'velha', activeSaleId: 'VEN-1', status: 'occupied', updatedAt: '2026-11-10T00:00:00Z' }];
  const site = [{ id: 10, tool_id: 'unlocktool', login: 'joao', password: 'Unlockfacil89', status: 'available', last_rotate_status: 'RECYCLED', last_rotate_at: '2026-11-11T05:39:00Z' }];
  const p = planSync(bot, site);
  assert.equal(p.siteOps.some(o => o.op === 'password'), false);
  assert.ok(p.botOps.some(o => o.op === 'update' && o.password === 'Unlockfacil89'));
  // e o vencimento é liberado com a senha do site, mesmo com a conta travada pela sincronia
  const e = planExpiry(setup(row(10, 'joao', 'Unlockfacil89', { status: 'sold', sync_locked: true, last_rotate_status: 'RECYCLED', last_rotate_at: '2026-11-14T06:00:00Z' }), { password: 'velha' }));
  assert.deepEqual(e.releaseRotated.map(r => r.password), ['Unlockfacil89']);
});

test('trocada com sucesso mas reprovada depois (licença expirada): libera no Discord para a sincronia retirar', () => {
  const e = planExpiry(setup(row(10, 'joao', 'Nova57', { status: 'unavailable', last_rotate_status: 'RECYCLED', last_rotate_at: '2026-11-14T06:00:00Z' })));
  assert.deepEqual(e.releaseRotated.map(r => r.password), ['Nova57']);
  assert.equal(e.failed.length, 0);
  const sync = planSync([{ id: 'ACC-1', tool: 'Unlock Tool', login: 'joao', password: 'Nova57', status: 'available' }],
    [{ id: 10, tool_id: 'unlocktool', login: 'joao', password: 'Nova57', status: 'unavailable', last_check_status: 'EXPIRED' }]);
  assert.deepEqual(sync.botOps.map(o => o.op), ['remove']);
});

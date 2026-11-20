'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteSync } = require('../src/site-sync');

// Banco falso: só a tabela discord_sync, com as consultas que o SiteSync usa para anúncios.
function fakePool(initial = []) {
  const rows = initial.map(r => ({ ...r }));
  return {
    rows,
    async query(sql, params = []) {
      if (/^SELECT event_id, record_id, price_cents, metadata FROM discord_sync WHERE event_type = 'ad_expense'/.test(sql)) {
        return { rows: rows.filter(r => r.event_type === 'ad_expense').map(r => ({ ...r })) };
      }
      if (/^DELETE FROM discord_sync WHERE event_id = \$1/.test(sql)) {
        const i = rows.findIndex(r => r.event_id === params[0]);
        if (i >= 0) rows.splice(i, 1);
        return { rowCount: i >= 0 ? 1 : 0 };
      }
      if (/^INSERT INTO discord_sync/.test(sql)) {
        const [event_type, event_id, record_id, , , , price_cents, , registered_at, metadata] = params;
        const old = rows.find(r => r.event_id === event_id);
        const row = { event_type, event_id, record_id, price_cents, registered_at, metadata: JSON.parse(metadata) };
        if (old) Object.assign(old, { price_cents, metadata: row.metadata }); else rows.push(row);
        return { rowCount: 1 };
      }
      throw new Error('consulta inesperada: ' + sql.slice(0, 60));
    }
  };
}
const quiet = { log() {}, error() {} };
const exp = (id, cents, date, createdAt, description = '') => ({ id, amountCents: cents, date, createdAt, description });
const row = (e, over = {}) => ({ event_type: 'ad_expense', event_id: `ad_expense:${e.id}:${e.createdAt}`, record_id: e.id, price_cents: e.amountCents, registered_at: e.createdAt, metadata: { date: e.date, description: e.description }, ...over });

test('valor editado no Discord é corrigido no site', async () => {
  const a = exp('ADS-039', 2500, '2026-11-12', '2026-11-12T17:44:43.026Z');
  const b = exp('ADS-001', 3000, '2026-10-01', '2026-10-09T03:21:07.882Z');
  const pool = fakePool([row(a, { price_cents: 4500 }), row(b)]);
  const changed = await new SiteSync({ pool, logger: quiet }).reconcileAdExpenses([a, b]);
  assert.equal(changed, 1);
  assert.equal(pool.rows.find(r => r.record_id === 'ADS-039').price_cents, 2500);
  assert.equal(pool.rows.length, 2);
});

test('data e descrição editadas também são corrigidas', async () => {
  const a = exp('ADS-010', 1300, '2026-10-10', '2026-10-11T14:27:12.563Z', 'nova');
  const pool = fakePool([row(a, { metadata: { date: '2026-10-11', description: '' } })]);
  await new SiteSync({ pool, logger: quiet }).reconcileAdExpenses([a]);
  assert.deepEqual(pool.rows[0].metadata, { date: '2026-10-10', description: 'nova' });
});

test('gasto que falta no site é criado; excluído do Discord sai do site', async () => {
  const a = exp('ADS-001', 3000, '2026-10-01', 'c1'), b = exp('ADS-002', 3000, '2026-10-02', 'c2'), c = exp('ADS-003', 3500, '2026-10-03', 'c3');
  const pool = fakePool([row(a), row(b), row(c)]);
  const d = exp('ADS-004', 100, '2026-10-04', 'c4');
  await new SiteSync({ pool, logger: quiet }).reconcileAdExpenses([a, b, d]);   // c excluído, d novo
  assert.deepEqual(pool.rows.map(r => r.record_id).sort(), ['ADS-001', 'ADS-002', 'ADS-004']);
});

test('registro duplicado (outro event_id) é removido', async () => {
  const a = exp('ADS-001', 3000, '2026-10-01', 'c1');
  const pool = fakePool([row(a), row(a, { event_id: 'ad_expense:ADS-001:outra-data' })]);
  await new SiteSync({ pool, logger: quiet }).reconcileAdExpenses([a]);
  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].event_id, 'ad_expense:ADS-001:c1');
});

test('sem diferenças: não escreve nada', async () => {
  const a = exp('ADS-001', 3000, '2026-10-01', 'c1');
  const pool = fakePool([row(a)]);
  let writes = 0; const q = pool.query.bind(pool);
  pool.query = (sql, p) => { if (!/^SELECT/.test(sql)) writes++; return q(sql, p); };
  assert.equal(await new SiteSync({ pool, logger: quiet }).reconcileAdExpenses([a]), 0);
  assert.equal(writes, 0);
});

test('trava: lista vazia ou que apagaria mais da metade não apaga nada', async () => {
  const list = ['1', '2', '3', '4'].map(n => exp('ADS-00' + n, 1000, '2026-10-0' + n, 'c' + n));
  const pool = fakePool(list.map(e => row(e)));
  const sync = new SiteSync({ pool, logger: quiet });
  assert.equal(await sync.reconcileAdExpenses([]), 0);
  assert.equal(await sync.reconcileAdExpenses([list[0]]), 0);
  assert.equal(pool.rows.length, 4);
});

test('sem banco configurado: não faz nada', async () => {
  assert.equal(await new SiteSync({ pool: null, logger: quiet }).reconcileAdExpenses([exp('ADS-001', 1, '2026-10-01', 'c')]), 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, getPlan, planChoices } = require('../src/catalog');
const { calculateExpiration, formatBR, parseDateTimeBR, buildRegisteredAt } = require('../src/dates');
const validation = require('../src/validation');
const { summarize, exportCsv } = require('../src/reporting');

test('catalog has the updated monthly plans and Borneo price, preserving TFM', () => {
  const expected = { 'Unlock Tool': { '12 horas': 2000, '3 meses': 6000, '6 meses': 9000 }, 'Borneo Schematics': { '3 dias': 4000 }, 'TSM Tool': { '12 horas': 2500 }, 'AMT Tool': { '12 horas': 2500 }, 'TFM Tool': { '12 horas': 2500 } };
  for (const [tool, plans] of Object.entries(expected)) {
    assert.deepEqual(Object.fromEntries(Object.entries(TOOLS[tool].plans).map(([plan, value]) => [plan, value.priceCents])), plans);
    assert.deepEqual(planChoices(tool).map(choice => choice.value), Object.keys(plans));
  }
  assert.throws(() => getPlan('AMT Tool', '3 meses'));
  assert.throws(() => getPlan('__proto__', '12 horas'));
  assert.deepEqual(planChoices('Unlock Tool', '12h').map(choice => choice.value), ['12 horas']);
  assert.deepEqual(planChoices('Borneo Schematics', '3 dias').map(choice => choice.value), ['3 dias']);
});

test('expiration preserves Brasilia calendar near midnight, month end and leap years', () => {
  for (const [start, plan, expected] of [
    ['2026-01-31T23:50:00-03:00', '1 mês', '28/02/2026 23:50'],
    ['2024-01-31T23:50:00-03:00', '1 mês', '29/02/2024 23:50'],
    ['2026-01-30T22:30:00-03:00', '3 meses', '30/04/2026 22:30'],
    ['2026-01-31T23:50:00-03:00', '3 meses', '30/04/2026 23:50'],
    ['2024-02-29T23:30:00-03:00', '12 meses', '28/02/2025 23:30'],
    ['2026-10-02T22:30:00-03:00', '12 horas', '03/10/2026 10:30'],
    ['2026-10-02T10:30:00-03:00', '3 dias', '05/10/2026 10:30']
  ]) assert.equal(formatBR(calculateExpiration(plan, new Date(start))), expected);
  assert.equal(parseDateTimeBR('31/02/2026 10:00'), null);
  assert.equal(parseDateTimeBR('01/01/2026 24:00'), null);
  assert.throws(() => buildRegisteredAt('03/10/2026', '10:00', new Date('2026-10-02T13:00:00Z')), /futuro/);
});

test('password characters and spaces are exact, unsafe record fields rejected, prices use cents', () => {
  assert.equal(validation.password(' a$&`b '), ' a$&`b ');
  assert.throws(() => validation.password('a\nb'));
  assert.throws(() => validation.text('x\n🔖 ID: VEN-100', 'Cliente'));
  assert.deepEqual(validation.amounts('Unlock Tool', '12 horas', null, 1.50), { priceCents: 1850, discountCents: 150 });
  assert.throws(() => validation.amounts('Unlock Tool', '12 horas', 10, 21));
  assert.throws(() => validation.cents(1.001, 'Valor'));
});

test('financial reports preserve stored sale prices and count renewals separately', () => {
  const records = [ { id: 'VEN-001', type: 'vendas', tool: 'Unlock Tool', plan: '12 horas', priceCents: 1000, registeredAt: '2026-10-02T13:00:00Z' }, { id: 'REN-001', type: 'renovacoes', tool: 'Unlock Tool', plan: '3 meses', priceCents: 5500, registeredAt: '2026-10-02T14:00:00Z' } ];
  const report = summarize(records, new Date('2026-10-02T15:00:00Z'));
  assert.deepEqual(report.today, { count: 2, value: 6500 });
  const csv = exportCsv([{ ...records[0], client: '=HYPERLINK("bad")', password: 'NEVER-EXPORT' }]).toString();
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(!csv.includes('NEVER-EXPORT'));
});


test('dashboard shows sold quantity by tool and plan plus ad spend summary', () => {
  const { dashboardText } = require('../src/reporting');
  const records = [
    { id: 'VEN-001', type: 'vendas', tool: 'Unlock Tool', plan: '12 horas', priceCents: 2000, registeredAt: '2026-10-08T15:00:00Z' },
    { id: 'VEN-002', type: 'vendas', tool: 'Unlock Tool', plan: '12 horas', priceCents: 2000, registeredAt: '2026-10-08T16:00:00Z' },
    { id: 'VEN-003', type: 'vendas', tool: 'TSM Tool', plan: '12 horas', priceCents: 2500, registeredAt: '2026-10-08T16:00:00Z' },
    { id: 'REN-001', type: 'renovacoes', tool: 'Unlock Tool', plan: '3 meses', priceCents: 6000, registeredAt: '2026-10-08T16:00:00Z' }
  ];
  const dashboard = dashboardText(records, [], new Date('2026-10-08T17:00:00Z'), [
    { id: 'ADS-001', date: '2026-10-08', amountCents: 1234, description: 'Meta Ads' },
    { id: 'ADS-002', date: '2026-10-01', amountCents: 500, description: 'Histórico' }
  ]);
  assert.match(dashboard, /Unlock Tool/);
  assert.match(dashboard, /12 horas: \*\*2 operação\(ões\)\*\*/);
  assert.match(dashboard, /Gastos com anúncios/);
  assert.match(dashboard, /R\$\s?12,34/);
  assert.match(dashboard, /R\$\s?17,34/);
});

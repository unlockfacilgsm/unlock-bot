'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSummary, hourBR } = require('../src/daily-summary');
const { formatPhone } = require('../src/site-sales');
const { planSync } = require('../src/account-sync');

test('resumo diário lista trocas, falhas e o que sobrou no /vencidas', () => {
  const text = buildSummary({ day: '2026-11-15', pending: [{ tool: 'TSM Tool' }, { tool: 'TSM Tool' }], notes: [
    { type: 'account.auto_released', message: 'VENC-1: senha trocada' },
    { type: 'account.auto_rotate_failed', message: 'VENC-2: falhou' },
    { type: 'checker.recycled', message: 'Conta #1 reciclada' },
  ] });
  assert.match(text, /15\/11\/2026/);
  assert.match(text, /Trocas automáticas no Discord: \*\*1\*\*/);
  assert.match(text, /VENC-2: falhou/);
  assert.match(text, /\/vencidas \(troca manual\): \*\*2\*\* — TSM Tool: 2/);
  assert.ok(text.length < 2000);
  assert.equal(hourBR(new Date('2026-11-15T11:00:00Z')), 8);
});

test('telefone no formato das vendas manuais', () => {
  assert.equal(formatPhone('5521984807044'), '+55 21 98480-7044');
  assert.equal(formatPhone('12997371234'), '+55 12 99737-1234');
  assert.equal(formatPhone(''), null);
});

test('pedido do site ligado à venda do Discord não é conflito', () => {
  const bot = [{ id: 'ACC-1', tool: 'Unlock Tool', login: 'x', password: 'p', activeSaleId: 'VEN-9', status: 'occupied' }];
  const site = (link) => [{ id: 1, tool_id: 'unlocktool', login: 'x', password: 'p', status: 'sold', order_id: 5, order_discord_sale_id: link }];
  assert.equal(planSync(bot, site('VEN-9')).conflicts.length, 0);
  assert.equal(planSync(bot, site('sincronizado-manual')).conflicts.length, 1);
});

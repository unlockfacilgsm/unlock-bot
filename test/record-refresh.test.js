'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { refreshRecords, refreshLegacyRecords } = require('../src/record-refresh');
const { parseLegacyRecord } = require('../src/migration');
const catalog = require('../src/catalog');

function fixture() {
  const edits = [];
  function channel(id, initial) {
    const history = initial.map(message => ({ ...message, author: { id: 'bot' }, attachments: new Map([['preserved', { name: 'credentials.json' }]]),
      async edit(payload) { edits.push({ id: this.id, payload }); this.content = payload.content; return this; }
    }));
    return { id, type: ChannelType.GuildText, history,
      permissionsFor: () => new PermissionsBitField(0n),
      messages: { async fetch(options) {
        if (typeof options === 'string') return history.find(message => message.id === options);
        return new Map(history.map(message => [message.id, message]));
      } }
    };
  }
  const sales = channel('sales', [{ id: 'sale-message', content: '**VENDA VEN-019**\nCliente: Cliente\nUF4:record:original-event' }]);
  const accounts = channel('accounts', [{ id: 'account-message', content: '**CONTA ACC-018**\nUF4:account:account-event' }]);
  const record = { id: 'VEN-019', type: 'vendas', client: 'Cliente', tool: 'AMT Tool', messageId: 'sale-message', login: 'LOGIN', priceCents: 2000, priceEstimated: true, plan: '12 horas' };
  const guild = { id: 'guild', roles: { everyone: { id: 'everyone' } }, channels: { cache: new Map([[sales.id, sales], [accounts.id, accounts]]) } };
  const store = {
    async getConfig() { return { vendas: sales.id, amtTool: accounts.id }; },
    async listRecords(guildId, type) { return type === 'vendas' ? [structuredClone(record)] : []; },
    async getDisplayRecord() { return { ...structuredClone(record), password: 'sale-password' }; },
    async transaction(callback) { return callback(); }
  };
  return { guild, store, client: { user: { id: 'bot' } }, record, edits, sales, accounts };
}

test('existing record refresh preserves message IDs, marker, original prices and account attachments', async () => {
  const f = fixture();
  const preview = await refreshRecords(f);
  assert.equal(preview.changed, 2); assert.equal(f.edits.length, 0);
  const applied = await refreshRecords({ ...f, dryRun: false });
  assert.equal(applied.changed, 2); assert.deepEqual(applied.errors, []);
  const sales = f.sales.history[0];
  assert.equal(sales.id, 'sale-message');
  assert.match(sales.content, /Senha: sale-password/);
  assert.match(sales.content, /UF4:record:original-event\n-----------------------------------------$/);
  assert.match(sales.content, /20,00 \(estimado na migração\)/);
  assert.equal(f.record.priceCents, 2000);
  assert.equal(f.accounts.history[0].attachments.size, 1);
  assert.ok(f.edits.every(edit => !Object.hasOwn(edit.payload, 'attachments')));
  assert.equal((await refreshRecords({ ...f, dryRun: false })).changed, 0);
});

test('refresh refuses a public channel and another authors message before exposing a password', async () => {
  const publicFixture = fixture();
  publicFixture.sales.permissionsFor = () => new PermissionsBitField(P.ViewChannel);
  await assert.rejects(refreshRecords({ ...publicFixture, dryRun: false }), /precisa ser privado/);
  assert.equal(publicFixture.edits.length, 0);
  const forged = fixture(); forged.sales.history[0].author.id = 'other';
  const report = await refreshRecords({ ...forged, dryRun: false });
  assert.equal(report.errors.length, 1);
  assert.ok(!forged.sales.history[0].content.includes('sale-password'));
});

test('archived records gain separators and a bold heading while all original fields remain importable', async () => {
  const f = fixture();
  f.sales.name = 'arquivo-💰・vendas';
  const message = f.sales.history[0];
  message.content = ['━━━━━━━━━━━━━━━━━━━━━━', '📌 VENDA', '🔖 ID: VEN-019', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: AMT Tool', '📦 PLANO: 12 horas', '🔐 LOGIN: `LOGIN`', '🔑 SENHA: `historical-password`', '⏰ VENCIMENTO: 03/10/2026 03:02', '📅 REGISTRADO EM: 02/10/2026 15:02', '━━━━━━━━━━━━━━━━━━━━━━'].join('\n');
  const before = parseLegacyRecord(message, catalog.TOOLS);
  const applied = await refreshLegacyRecords({ ...f, dryRun: false });
  assert.equal(applied.changed, 1); assert.deepEqual(applied.errors, []);
  assert.match(message.content, /\*\*VENDA VEN-019\*\*/);
  assert.deepEqual(parseLegacyRecord(message, catalog.TOOLS), before);
  assert.equal((await refreshLegacyRecords({ ...f, dryRun: false })).changed, 0);
});

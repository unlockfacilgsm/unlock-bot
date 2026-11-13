'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { SiteSales } = require('../src/site-sales');
const { renderRecord } = require('../src/transport');

const GUILD = 'guild-site';

function memoryStore() {
  const messages = new Map();
  const downloads = new Map();
  let nextId = 0;
  const channel = {
    id: 'data', guildId: GUILD, client: { user: { id: 'bot' } },
    messages: { async fetch({ limit = 100, before } = {}) {
      return new Map([...messages.values()].filter(m => !before || BigInt(m.id) < BigInt(before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, limit).map(m => [m.id, m]));
    } },
    async send(options) {
      const id = String(++nextId);
      const attachments = new Map();
      for (const [index, file] of (options.files || []).entries()) {
        const url = `memory://${id}/${index}`;
        downloads.set(url, Buffer.from(file.attachment));
        attachments.set(String(index), { name: file.name, url });
      }
      const message = { id, author: { id: 'bot' }, content: options.content, attachments, createdTimestamp: nextId };
      messages.set(id, message);
      return message;
    },
  };
  return new Store({ channel, guildId: GUILD, encryptionKey: Buffer.alloc(32, 9), downloadAttachment: async url => downloads.get(url) });
}

const siteSale = (overrides = {}) => ({ siteOrder: 'UF-ABC-123', source: 'site', client: 'Maria Silva', tool: 'Unlock Tool',
  plan: '1 mês', priceCents: 3000, registeredAt: '2090-01-01T12:00:00Z', expiresAt: '2090-01-31T12:00:00Z', ...overrides });

test('site sale is recorded once per order, without binding a bot stock account', async () => {
  const store = memoryStore(); await store.load();
  const first = await store.createSiteSale(GUILD, siteSale());
  const again = await store.createSiteSale(GUILD, siteSale({ client: 'Outro nome' }));
  assert.equal(again.id, first.id);
  assert.match(first.id, /^VEN-/);
  assert.equal(first.accountId, undefined);
  assert.equal((await store.listRecords(GUILD, 'vendas')).length, 1);
  assert.equal((await store.listAccounts(GUILD)).length, 0);
  assert.deepEqual(await store.expireSales(GUILD, '2090-03-01T00:00:00Z'), []);
  await assert.rejects(store.renewSale(GUILD, { saleId: first.id, plan: '1 mês', priceCents: 3000 }), /não tem renovação/);
});

test('site sale shows its origin and never a password line', async () => {
  const store = memoryStore(); await store.load();
  const sale = await store.createSiteSale(GUILD, siteSale({ source: 'whatsapp', siteOrder: 'UF-WA-1' }));
  const text = renderRecord(await store.getDisplayRecord(GUILD, 'vendas', sale.id));
  assert.match(text, /Origem: WhatsApp \(bot\) — pedido UF-WA-1/);
  assert.doesNotMatch(text, /Senha/);
});

test('importer registers delivered orders, marks them and skips unknown tools', async () => {
  const orders = [
    { id: 1, order_code: 'UF-1', plan_id: 'unlocktool-1m', plan_name: '1 mês', amount_cents: 3000, buyer_name: 'Ana  Souza', origin: 'site', delivered_at: '2090-01-01T12:00:00Z' },
    { id: 2, order_code: 'UF-CUR-2', plan_id: 'course-unlocktool', plan_name: 'Acesso ao curso', amount_cents: 4000, buyer_email: 'a@b.c', origin: 'course', delivered_at: '2090-01-01T13:00:00Z' },
    { id: 3, order_code: 'UF-3', plan_id: 'naoexiste-1m', plan_name: '1 mês', amount_cents: 1000, origin: 'site', delivered_at: '2090-01-01T14:00:00Z' },
  ];
  const marks = [];
  const pool = { async query(sql, params) {
    if (sql.startsWith('UPDATE')) { marks.push(params); return { rows: [] }; }
    return { rows: orders };
  } };
  const created = [];
  const store = { async createSiteSale(guildId, data) { created.push(data); return { id: `VEN-${created.length}`, ...data }; } };
  const synced = [];
  const importer = new SiteSales({ pool, store, guildId: GUILD, siteSync: { async syncSale(sale) { synced.push(sale.id); } }, logger: { log() {}, error() {} } });
  assert.equal(await importer.run(), 2);
  assert.deepEqual(created.map(c => [c.tool, c.plan, c.client]), [['Unlock Tool', '1 mês', 'Ana Souza'], ['Unlock Tool', 'Curso', 'a@b.c']]);
  assert.deepEqual(synced, ['VEN-1', 'VEN-2']);
  assert.deepEqual(marks, [['VEN-1', 1], ['VEN-2', 2], ['ignorado', 3]]);
});

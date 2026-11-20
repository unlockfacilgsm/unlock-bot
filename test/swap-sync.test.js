'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Store } = require('../src/store');
const { SwapSync, samePhone } = require('../src/swap-sync');

const GUILD = 'guild-swap';
const SITE_KEY = 'ab'.repeat(32);

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

function siteEncrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(SITE_KEY, 'hex'), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function fakePool({ swaps, orders = [] }) {
  const updates = [], notes = [];
  return {
    updates, notes,
    async query(sql, params) {
      if (/FROM account_swaps/.test(sql)) return { rows: swaps.filter(s => s.discord_status === 'pending') };
      if (/UPDATE account_swaps/.test(sql)) { const s = swaps.find(x => x.id === params[0]); Object.assign(s, { discord_status: params[1], discord_record: params[2], discord_error: params[3] }); updates.push(params); return { rows: [] }; }
      if (/FROM orders/.test(sql)) return { rows: orders.filter(o => o.id === params[0]) };
      if (/INSERT INTO notifications/.test(sql)) { notes.push(params[0]); return { rows: [] }; }
      throw new Error('SQL inesperado: ' + sql);
    },
  };
}

const swap = (o) => ({ id: 1, created_at: new Date().toISOString(), discord_status: 'pending', tool_id: 'unlocktool', mode: 'auto',
  phone: '5511988887777', old_login: 'velha', new_credentials: siteEncrypt({ login: 'nova', password: 'Senha123' }), ...o });

test('site sale: records a trade and updates the sale login', async () => {
  const store = memoryStore(); await store.load();
  const sale = await store.createSiteSale(GUILD, { siteOrder: 'UF-WA-1', source: 'whatsapp', client: '+55 11 98888-7777', tool: 'Unlock Tool',
    plan: '24 horas', priceCents: 1000, registeredAt: '2090-01-01T12:00:00Z' });
  const swaps = [swap({ order_id: 10 })];
  const pool = fakePool({ swaps, orders: [{ id: 10, order_code: 'UF-WA-1', discord_sale_id: sale.id }] });
  const sync = new SwapSync({ pool, store, guildId: GUILD, siteKey: SITE_KEY, logger: { log() {}, error() {} } });
  assert.equal(await sync.run(), 1);
  assert.equal(swaps[0].discord_status, 'done');
  assert.match(swaps[0].discord_record, /^TRC-/);
  assert.equal((await store.getRecord(GUILD, 'vendas', sale.id)).login, 'nova');
  const trade = await store.getRecord(GUILD, 'trocas', swaps[0].discord_record);
  assert.equal(trade.saleId, sale.id);
  assert.match(trade.observation, /velha → nova/);
});

test('site order not yet in Discord: waits for the next round', async () => {
  const store = memoryStore(); await store.load();
  const swaps = [swap({ order_id: 11 })];
  const pool = fakePool({ swaps, orders: [{ id: 11, order_code: 'UF-2', discord_sale_id: null }] });
  const sync = new SwapSync({ pool, store, guildId: GUILD, siteKey: SITE_KEY, logger: { log() {}, error() {} } });
  assert.equal(await sync.run(), 0);
  assert.equal(swaps[0].discord_status, 'pending');
});

test('/vender sale (stock account): replaces the account by phone', async () => {
  const store = memoryStore(); await store.load();
  await store.upsertAccount(GUILD, { tool: 'Unlock Tool', login: 'velha', password: 'Antiga123' });
  const sale = await store.createSale(GUILD, { client: '+55 11 98888-7777', tool: 'Unlock Tool', plan: '1 mês', priceCents: 3000, login: 'velha', registeredAt: new Date().toISOString() });
  const swaps = [swap({ order_id: null, mode: 'manual' })];
  const pool = fakePool({ swaps });
  const sync = new SwapSync({ pool, store, guildId: GUILD, siteKey: SITE_KEY, logger: { log() {}, error() {} } });
  assert.equal(await sync.run(), 1);
  const updated = await store.getRecord(GUILD, 'vendas', sale.id);
  assert.equal(updated.login, 'nova');
  assert.notEqual(updated.accountId, sale.accountId);
});

test('no Discord sale for the phone: error + panel notification', async () => {
  const store = memoryStore(); await store.load();
  const swaps = [swap({ order_id: null, phone: '5511900000000' })];
  const pool = fakePool({ swaps });
  const sync = new SwapSync({ pool, store, guildId: GUILD, siteKey: SITE_KEY, logger: { log() {}, error() {} } });
  await sync.run();
  assert.equal(swaps[0].discord_status, 'error');
  assert.equal(pool.notes.length, 1);
});

test('phone matching ignores formatting and country code', () => {
  assert.ok(samePhone('+55 11 98888-7777', '5511988887777'));
  assert.ok(!samePhone('+55 11 98888-7777', '5511988887770'));
  assert.ok(!samePhone('Maria', '5511988887777'));
});

test('exact Discord sale chosen in the Central: uses it even with another active sale for the phone', async () => {
  const store = memoryStore(); await store.load();
  await store.upsertAccount(GUILD, { tool: 'Unlock Tool', login: 'velha', password: 'Antiga123' });
  await store.upsertAccount(GUILD, { tool: 'Unlock Tool', login: 'outra', password: 'Outra123' });
  const older = await store.createSale(GUILD, { client: '+55 11 98888-7777', tool: 'Unlock Tool', plan: '1 mês', priceCents: 3000, login: 'velha', registeredAt: new Date(Date.now() - 86400e3).toISOString() });
  const newer = await store.createSale(GUILD, { client: '+55 11 98888-7777', tool: 'Unlock Tool', plan: '1 mês', priceCents: 3000, login: 'outra', registeredAt: new Date().toISOString() });
  const swaps = [swap({ order_id: null, mode: 'manual', discord_sale_id: older.id })];
  const sync = new SwapSync({ pool: fakePool({ swaps }), store, guildId: GUILD, siteKey: SITE_KEY, logger: { log() {}, error() {} } });
  assert.equal(await sync.run(), 1);
  assert.equal((await store.getRecord(GUILD, 'vendas', older.id)).login, 'nova');
  assert.equal((await store.getRecord(GUILD, 'vendas', newer.id)).login, 'outra');
});

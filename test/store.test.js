'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

const KEY = Buffer.alloc(32, 17);
const GUILD = 'guild-1';

function discordFixture(id = `data-${Math.random()}`) {
  const messages = new Map();
  const downloads = new Map();
  let nextId = 0;
  let fail = null;
  let failAfter = null;
  const fixture = {
    messages, downloads, fetched: [], downloaded: [], sent: [],
    failNext(where = 'before') { fail = where; },
    failOnSend(number, where = 'before') { failAfter = { number, where }; },
    addMessage({ author = 'human', content = '', attachment } = {}) {
      const messageId = String(++nextId);
      const attachments = new Map();
      if (attachment) {
        const url = `memory://${id}/${messageId}`;
        downloads.set(url, Buffer.from(attachment));
        attachments.set('attachment', { name: 'unlock-event.json', url });
      }
      const message = { id: messageId, author: { id: author }, content, attachments, createdTimestamp: nextId };
      messages.set(messageId, message);
      return message;
    },
  };
  const channel = {
    id, guildId: GUILD, client: { user: { id: 'bot' } },
    messages: {
      async fetch({ limit = 100, before } = {}) {
        fixture.fetched.push({ limit, before });
        return new Map([...messages.values()]
          .filter((message) => !before || BigInt(message.id) < BigInt(before))
          .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
          .slice(0, limit).map((message) => [message.id, message]));
      },
    },
    async send(options) {
      fixture.sent.push(options);
      if (failAfter && fixture.sent.length === failAfter.number) { fail = failAfter.where; failAfter = null; }
      const failure = fail; fail = null;
      if (failure === 'before') throw new Error('Simulated Discord disconnect before persistence');
      const messageId = String(++nextId);
      const attachments = new Map();
      for (const [index, file] of (options.files || []).entries()) {
        const url = `memory://${id}/${messageId}/${index}`;
        downloads.set(url, Buffer.from(file.attachment));
        attachments.set(String(index), { name: file.name, url });
      }
      const message = { id: messageId, author: { id: 'bot' }, content: options.content,
        attachments, createdTimestamp: nextId, nonce: options.nonce };
      messages.set(messageId, message);
      if (failure === 'after') throw new Error('Simulated Discord disconnect after persistence');
      return message;
    },
  };
  fixture.channel = channel;
  fixture.store = () => new Store({ channel, guildId: GUILD, encryptionKey: KEY,
    clock: () => new Date('2090-01-02T10:00:00.000Z'),
    downloadAttachment: async (url) => { fixture.downloaded.push(url); return downloads.get(url); } });
  return fixture;
}

function saleData(overrides = {}) {
  return { client: 'Cliente de teste', tool: 'Unlock Tool', plan: '12 horas', login: 'login-1',
    password: 'senha-1', priceCents: 1000, discountCents: 0,
    registeredAt: '2090-01-01T15:00:00.000Z', actorId: 'seller-1', ...overrides };
}

test('sale corrections keep IDs and prices unless explicitly edited and cancel stale expirations', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const sale = await store.createSale(GUILD, saleData());
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  const edited = await store.editSale(GUILD, { saleId: sale.id, changes: { client: 'Corrected', plan: '3 meses', login: 'corrected-login', password: '  corrected$&  ' }, actorId: 'admin' });
  assert.equal(edited.id, sale.id); assert.equal(edited.priceCents, 1000);
  assert.equal(edited.expiresAt, '2090-04-01T15:00:00.000Z');
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', sale.id)).password, '  corrected$&  ');
  assert.equal((await store.getAccount(GUILD, sale.accountId)).login, 'corrected-login');
  const [expiration] = await store.expireSales(GUILD, '2090-04-02T15:00:00Z');
  await store.editSale(GUILD, { saleId: sale.id, changes: { expiresAt: '2090-03-01T15:00:00Z' } });
  assert.equal((await store.getRecord(GUILD, 'vencimentos', expiration.id)).status, 'cancelled');
  assert.equal((await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'bad' })).changed.length, 0);
  await assert.rejects(store.editSale(GUILD, { saleId: sale.id, changes: { plan: 'invalid' } }), /plano/i);
  assert.equal((await store.getRecord(GUILD, 'vendas', sale.id)).plan, '3 meses');
});

test('replacement validates the old plan, reserves one new account and preserves encrypted trade history', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const sale = await store.createSale(GUILD, saleData());
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  const data = { saleId: sale.id, previousPlan: '12 horas', newPlan: '3 meses', login: 'replacement-login', password: ' replacement-secret ', registeredAt: '2090-01-02T15:00:00Z', actorId: 'seller' };
  await assert.rejects(store.replaceSaleAccount(GUILD, { ...data, previousPlan: '3 meses' }), /plano anterior/);
  const trade = await store.replaceSaleAccount(GUILD, data);
  const current = await store.getRecord(GUILD, 'vendas', sale.id);
  assert.equal(current.id, sale.id); assert.equal(current.priceCents, 1000);
  assert.equal(current.currentPlan, '3 meses'); assert.equal(current.login, data.login);
  assert.equal(current.expiresAt, '2090-04-02T15:00:00.000Z');
  assert.equal((await store.getAccount(GUILD, sale.accountId)).needsPasswordReset, true);
  assert.equal((await store.getDisplayRecord(GUILD, 'trocas', trade.id)).password, data.password);
  assert.equal(trade.password, undefined); assert.equal(trade.passwordEncrypted, undefined);
  assert.ok(!JSON.stringify([...fixture.downloads.values()].map(value => value.toString())).includes(data.password));
  const restored = discordFixture().store(); await restored.restoreSnapshot(await store.exportSnapshot());
  assert.equal((await restored.getDisplayRecord(GUILD, 'trocas', trade.id)).password, data.password);
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  await store.updateAccountPassword(GUILD, { accountId: sale.accountId, newPassword: 'reset-password' });
  assert.equal((await store.getAccount(GUILD, sale.accountId)).status, 'available');
  assert.equal((await store.getAccount(GUILD, current.accountId)).activeSaleId, sale.id);
});

test('sales reserve accounts atomically and concurrent counters remain unique', async () => {
  const fixture = discordFixture();
  const store = fixture.store(); await store.load();
  const competing = await Promise.allSettled([store.createSale(GUILD, saleData()), store.createSale(GUILD, saleData())]);
  assert.equal(competing.filter((item) => item.status === 'fulfilled').length, 1);
  assert.match(competing.find((item) => item.status === 'rejected').reason.message, /ocupada/);
  const sales = await Promise.all(Array.from({ length: 15 }, (_, index) =>
    store.createSale(GUILD, saleData({ login: `login-${index + 2}` }))));
  assert.equal(new Set(sales.map((sale) => sale.id)).size, 15);
  assert.equal(sales.at(-1).id, 'VEN-016');
  const first = (await store.listRecords(GUILD, 'vendas')).find((sale) => sale.id === 'VEN-001');
  const account = await store.getAccount(GUILD, first.accountId);
  assert.equal(account.status, 'occupied'); assert.equal(account.activeSaleId, first.id);
  await assert.rejects(store.upsertAccount(GUILD, { tool: first.tool, login: first.login, password: 'overwrite' }), /ocupada/);
});

test('private display retains original sale credentials after password changes, reuse and backup restore', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const original = await store.createSale(GUILD, saleData({ password: ' original$&` ' }));
  const [expiration] = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'new-credential' });
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  const latest = await store.createSale(GUILD, saleData({ accountId: original.accountId, password: undefined, registeredAt: '2090-01-02T15:00:00Z' }));
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', original.id)).password, ' original$&` ');
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', latest.id)).password, 'new-credential');
  const standard = await store.getRecord(GUILD, 'vendas', original.id);
  assert.equal(standard.password, undefined); assert.equal(standard.passwordEncrypted, undefined);
  assert.ok(!(await store.listRecords(GUILD, 'vendas')).some(record => record.password || record.passwordEncrypted));
  assert.ok(!JSON.stringify([...fixture.downloads.values()].map(value => value.toString())).includes('new-credential'));
  const restored = discordFixture().store();
  await restored.restoreSnapshot(await store.exportSnapshot());
  assert.equal((await restored.getDisplayRecord(GUILD, 'vendas', original.id)).password, ' original$&` ');
});

test('old sales without a credential snapshot never borrow the password of a newer sale', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const account = await store.upsertAccount(GUILD, saleData());
  const old = await store.saveImportedRecord(GUILD, 'vendas', { ...saleData(), password: undefined, id: 'VEN-100', accountId: account.id, expiresAt: '2090-01-02T03:00:00Z', status: 'active' });
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', old.id)).password, 'senha-1');
  const [expiration] = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'different-owner-password' });
  for (const item of await store.listOutbox(GUILD)) await store.completeOutbox(item.id);
  await store.createSale(GUILD, saleData({ accountId: account.id, password: undefined, registeredAt: '2090-01-02T15:00:00Z' }));
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', old.id)).password, undefined);
});

test('preserving a verified legacy sale credential is encrypted, idempotent and leaves the current account unchanged', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.upsertAccount(GUILD, saleData({ password: 'current-account-password' }));
  const source = { ...saleData({ password: 'original-sale-password' }), id: 'VEN-100',
    legacyMessageId: 'legacy-message', legacyChannelId: 'legacy-channel', expiresAt: '2090-01-02T03:00:00.000Z' };
  const sale = await store.saveImportedRecord(GUILD, 'vendas', { ...source, password: undefined, status: 'released' });
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', sale.id)).password, undefined);
  await assert.rejects(store.preserveLegacySalePassword(GUILD, { saleId: sale.id, source: { ...source, legacyMessageId: 'different' } }), /fonte antiga/);
  await store.preserveLegacySalePassword(GUILD, { saleId: sale.id, source, actorId: 'bot' });
  const count = fixture.sent.length;
  await store.preserveLegacySalePassword(GUILD, { saleId: sale.id, source, actorId: 'bot' });
  assert.equal(fixture.sent.length, count);
  assert.equal((await store.getDisplayRecord(GUILD, 'vendas', sale.id)).password, 'original-sale-password');
  assert.equal((await store.getAccount(GUILD, sale.accountId)).password, 'current-account-password');
  assert.ok(!JSON.stringify([...fixture.downloads.values()].map(value => value.toString())).includes('original-sale-password'));
  await assert.rejects(store.preserveLegacySalePassword(GUILD, { saleId: sale.id, source: { ...source, password: 'replacement' } }), /diferente/);
});

test('expired account release survives publication failure and blocks resale until delivery', async () => {
  const fixture = discordFixture();
  const store = fixture.store(); await store.load();
  const sale = await store.createSale(GUILD, saleData());
  const [expiration] = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  assert.equal(expiration.saleId, sale.id);
  assert.deepEqual(await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z'), []);
  const result = await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: '  $&`new-password  ', actorId: 'seller-2' });
  assert.equal(result.changed.length, 1); assert.deepEqual(result.errors, []);
  const delivery = (await store.listOutbox(GUILD)).find((entry) => entry.kind === 'free-account');
  await store.failOutbox(delivery.id, new Error('Sensitive request:  $&`new-password  '));
  assert.equal(await store.pendingDeliveryForAccount(GUILD, sale.accountId), true);
  await assert.rejects(store.createSale(GUILD, saleData({ accountId: sale.accountId, password: undefined })), /pendente/);
  const repeated = await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'should-not-change' });
  assert.equal(repeated.changed.length, 0); assert.match(repeated.errors[0].message, /já processado/);
  assert.equal((await store.listOutbox(GUILD)).filter((entry) => entry.kind === 'free-account').length, 1);
  const reloaded = fixture.store(); await reloaded.load();
  assert.equal((await reloaded.getAccount(GUILD, sale.accountId)).password, '  $&`new-password  ');
  assert.equal((await reloaded.listOutbox(GUILD)).find((entry) => entry.id === delivery.id).attempts, 1);
  await reloaded.completeOutbox(delivery.id, { messageId: '999', channelId: 'free-channel' });
  assert.equal(await reloaded.pendingDeliveryForAccount(GUILD, sale.accountId), false);
  const available = await reloaded.getAccount(GUILD, sale.accountId);
  assert.equal(available.freeMessageId, '999'); assert.equal(available.freeChannelId, 'free-channel');
  const newSale = await reloaded.createSale(GUILD, saleData({ accountId: sale.accountId, password: undefined }));
  assert.equal(newSale.id, 'VEN-002');
  assert.equal((await reloaded.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'bad' })).changed.length, 0);
});

test('batch release commits each account independently and can resume only failures', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.createSale(GUILD, saleData());
  await store.createSale(GUILD, saleData({ login: 'login-2' }));
  const expirations = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  fixture.failOnSend(fixture.sent.length + 2);
  const first = await store.releaseAccounts(GUILD, { expirationIds: expirations.map((entry) => entry.id), newPassword: 'new' });
  assert.equal(first.changed.length, 1); assert.equal(first.errors.length, 1);
  assert.equal((await store.getRecord(GUILD, 'vencimentos', first.errors[0].id)).status, 'pending');
  const resumed = await store.releaseAccounts(GUILD, { expirationIds: [first.errors[0].id], newPassword: 'new' });
  assert.equal(resumed.changed.length, 1);
  assert.equal((await store.listOutbox(GUILD)).filter((entry) => entry.kind === 'free-account').length, 2);
});

test('renewal keeps original financial history and cancels stale expirations', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const original = await store.createSale(GUILD, saleData({ priceCents: 100, discountCents: 900 }));
  const [expired] = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  const renewal = await store.renewSale(GUILD, { saleId: original.id, plan: '3 meses', priceCents: 5000,
    discountCents: 500, registeredAt: '2090-01-03T15:00:00.000Z', actorId: 'seller' });
  assert.equal(renewal.id, 'REN-001'); assert.equal(renewal.expiresAt, '2090-04-03T15:00:00.000Z');
  const sale = await store.getRecord(GUILD, 'vendas', original.id);
  assert.equal(sale.plan, '12 horas'); assert.equal(sale.currentPlan, '3 meses');
  assert.equal(sale.priceCents, 100); assert.equal(sale.discountCents, 900); assert.equal(sale.registeredAt, original.registeredAt);
  assert.equal((await store.getRecord(GUILD, 'vencimentos', expired.id)).status, 'cancelled');
  const release = await store.releaseAccounts(GUILD, { expirationIds: [expired.id], newPassword: 'bad' });
  assert.equal(release.changed.length, 0); assert.match(release.errors[0].message, /cancelado/);
  const renewal2 = await store.renewSale(GUILD, { saleId: original.id, plan: '12 horas', priceCents: 1000,
    registeredAt: '2090-01-04T15:00:00.000Z' });
  assert.equal(renewal2.expiresAt, '2090-04-04T03:00:00.000Z');
  assert.equal((await store.listRecords(GUILD, 'renovacoes')).reduce((sum, record) => sum + record.priceCents, sale.priceCents), 6100);
});

test('password confirmations preserve exact bytes without freeing occupied accounts or leaking secrets', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const secret = '  $&`sensitive-password  ';
  const sale = await store.createSale(GUILD, saleData({ password: secret }));
  assert.equal((await store.getAccount(GUILD, sale.accountId)).password, secret);
  const [expired] = await store.expireSales(GUILD, '2090-01-02T10:00:00.000Z');
  await store.updatePassword(GUILD, { expirationId: expired.id, newPassword: 'confirmed-external' });
  assert.equal((await store.getAccount(GUILD, sale.accountId)).status, 'occupied');
  assert.equal((await store.getRecord(GUILD, 'vencimentos', expired.id)).status, 'pending');
  await store.updateAccountPassword(GUILD, { accountId: sale.accountId, newPassword: secret, actorId: 'seller' });
  const persisted = [...fixture.downloads.values()].map((buffer) => buffer.toString()).join('\n');
  assert.equal(persisted.includes(secret), false); assert.equal(persisted.includes('confirmed-external'), false);
  assert.equal(JSON.stringify(await store.listAudit(GUILD)).includes(secret), false);
  assert.equal(JSON.stringify(await store.listRecords(GUILD, 'vendas')).includes('password'), false);
  await assert.rejects(store.upsertAccount(GUILD, { tool: 'Unlock Tool', login: 'another', password: 'line\nbreak' }), /Senha inválida/);
});

test('unconfirmed writes leave no partial state while lost confirmations reconcile exactly once', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  fixture.failNext('before');
  await assert.rejects(store.createSale(GUILD, saleData()), /não confirmou/);
  assert.equal((await store.listRecords(GUILD, 'vendas')).length, 0); assert.equal((await store.listAccounts(GUILD)).length, 0);
  fixture.failNext('after');
  const confirmed = await store.createSale(GUILD, saleData());
  assert.equal(confirmed.id, 'VEN-001'); assert.equal((await store.listRecords(GUILD, 'vendas')).length, 1);
  assert.equal(fixture.messages.size, 1);
  const reloaded = fixture.store(); await reloaded.load();
  assert.equal((await reloaded.getRecord(GUILD, 'vendas', confirmed.id)).accountId, confirmed.accountId);
});

test('transaction serializes several domain changes into one durable Discord message', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.transaction(async () => {
    await store.setConfig(GUILD, 'roles', { seller: 'role-1' });
    await store.createSale(GUILD, saleData());
  });
  assert.equal(fixture.messages.size, 1);
  assert.equal((await store.getConfig(GUILD, 'roles')).seller, 'role-1');
  await assert.rejects(store.transaction(async () => {
    await store.setConfig(GUILD, 'roles', { seller: 'role-2' });
    await store.createSale(GUILD, saleData());
  }), /ocupada/);
  assert.equal((await store.getConfig(GUILD, 'roles')).seller, 'role-1'); assert.equal(fixture.messages.size, 1);
});

test('imports are idempotent, preserve duplicate legacy IDs and protect newer allocations', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const older = { ...saleData({ id: 'VEN-100', status: 'expired', expiresAt: '2090-01-02T03:00:00.000Z',
    registeredAt: '2090-01-01T15:00:00.000Z' }), messageId: 'legacy-1' };
  await store.saveImportedRecord(GUILD, 'vendas', older);
  await store.saveImportedRecord(GUILD, 'vendas', older);
  const newer = { ...older, id: 'VEN-LEGACY-456', legacyId: 'VEN-100', registeredAt: '2090-02-01T15:00:00.000Z',
    status: 'active', expiresAt: '2090-02-02T03:00:00.000Z', password: 'newer-password' };
  const assigned = await store.saveImportedRecord(GUILD, 'vendas', newer);
  await store.saveImportedAccount(GUILD, { tool: older.tool, login: older.login, password: 'stale-free-password', status: 'available' });
  assert.equal((await store.getAccount(GUILD, assigned.accountId)).password, 'newer-password');
  assert.equal((await store.getAccount(GUILD, assigned.accountId)).activeSaleId, assigned.id);
  await store.saveImportedRecord(GUILD, 'vencimentos', { id: 'VENC-100', saleId: older.id, client: older.client,
    tool: older.tool, login: older.login, expiresAt: older.expiresAt, registeredAt: older.expiresAt, status: 'pending' });
  const release = await store.releaseAccounts(GUILD, { expirationIds: ['VENC-100'], newPassword: 'bad' });
  assert.match(release.errors[0].message, /outra venda/);
  const created = await store.createSale(GUILD, saleData({ login: 'other-login' }));
  assert.equal(created.id, 'VEN-101');
  assert.equal((await store.listRecords(GUILD, 'vendas')).length, 3);
  assert.equal((await store.listOutbox(GUILD)).filter((entry) => entry.payload.id === older.id).length, 1);
});

test('late imported inventory reconciles records without allowing a live account overwrite', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const imported = await store.saveImportedRecord(GUILD, 'vendas', { ...saleData({ password: undefined }),
    id: 'VEN-007', expiresAt: '2090-01-02T03:00:00.000Z', status: 'active' });
  assert.equal(imported.accountId, undefined);
  const account = await store.saveImportedAccount(GUILD, { tool: imported.tool, login: imported.login, password: 'recovered-password' });
  assert.equal(account.status, 'occupied'); assert.equal(account.activeSaleId, imported.id);
  assert.equal((await store.getRecord(GUILD, 'vendas', imported.id)).accountId, account.id);
});

test('load reads past 2000 messages and ignores human-authored forged data', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.setConfig(GUILD, 'old-setting', 'retained');
  const validEvent = [...fixture.downloads.values()][0];
  for (let index = 0; index < 2100; index += 1) fixture.addMessage();
  fixture.addMessage({ attachment: validEvent });
  const reloaded = fixture.store(); await reloaded.load();
  assert.equal(await reloaded.getConfig(GUILD, 'old-setting'), 'retained');
  assert.ok(fixture.fetched.filter((fetch) => fetch.before).length > 20);
});

test('event integrity and encryption keys are verified before applying reconstructed state', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.createSale(GUILD, saleData());
  const wrong = new Store({ channel: fixture.channel, guildId: GUILD, encryptionKey: Buffer.alloc(32, 18),
    downloadAttachment: async (url) => fixture.downloads.get(url) });
  await assert.rejects(wrong.load(), /autenticação/);
  const [url, data] = [...fixture.downloads.entries()][0];
  const altered = JSON.parse(data.toString()); altered.changes.records.vendas[0].priceCents = 0;
  fixture.downloads.set(url, Buffer.from(JSON.stringify(altered)));
  await assert.rejects(fixture.store().load(), /autenticação/);
});

test('encrypted backups restore to an empty Discord channel and reject overwrite or wrong key', async () => {
  const source = discordFixture(); const store = source.store(); await store.load();
  const sale = await store.createSale(GUILD, saleData({ password: 'private-backup-secret' }));
  await store.setConfig(GUILD, 'roles', { seller: 'private-role' });
  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.toString().includes('private-backup-secret'), false);
  assert.equal(snapshot.toString().includes('private-role'), false);
  const target = discordFixture(); const restored = target.store(); await restored.load();
  const summary = await restored.restoreSnapshot(snapshot);
  assert.equal(summary.records, 1); assert.equal(summary.accounts, 1);
  assert.equal((await restored.getAccount(GUILD, sale.accountId)).password, 'private-backup-secret');
  assert.deepEqual(await restored.getConfig(GUILD, 'roles'), { seller: 'private-role' });
  const next = await restored.createSale(GUILD, saleData({ login: 'restored-new' })); assert.equal(next.id, 'VEN-002');
  const reconstructed = target.store(); await reconstructed.load();
  assert.equal((await reconstructed.listRecords(GUILD, 'vendas')).length, 2);
  await assert.rejects(restored.restoreSnapshot(snapshot), /canal de dados vazio/);
  const other = discordFixture();
  const wrongKey = new Store({ channel: other.channel, guildId: GUILD, encryptionKey: Buffer.alloc(32, 20),
    downloadAttachment: async (url) => other.downloads.get(url) });
  await assert.rejects(wrongKey.restoreSnapshot(snapshot), /Backup inválido/);
  assert.equal(other.messages.size, 0);
});

test('two stores on the same channel synchronize the ledger head before committing', async () => {
  const fixture = discordFixture(); const first = fixture.store(), second = fixture.store();
  await first.load(); await second.load();
  const [a, b] = await Promise.all([
    first.createSale(GUILD, saleData({ login: 'first' })),
    second.createSale(GUILD, saleData({ login: 'second' })),
  ]);
  assert.deepEqual([a.id, b.id], ['VEN-001', 'VEN-002']);
  const reloaded = fixture.store(); await reloaded.load(); assert.equal((await reloaded.listRecords(GUILD, 'vendas')).length, 2);
});

test('unknown outbox kinds complete safely and dedupe keys prevent duplicate reminders', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const first = await store.queueOutbox(GUILD, 'reminder', { saleId: 'VEN-001', expiresAt: '2090-01-01T00:00:00Z' }, 'reminder:1');
  const duplicate = await store.enqueueOutbox(GUILD, 'reminder', first.payload, 'reminder:1');
  assert.equal(first.id, duplicate.id); assert.equal((await store.listOutbox(GUILD)).length, 1);
  await store.completeOutbox(first.id); assert.equal((await store.listOutbox(GUILD)).length, 0);
});

test('checkpoints replay only newer events, retain history and preserve counters', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.createSale(GUILD, saleData());
  assert.equal(await store.checkpointIfNeeded(2), null);
  await store.setConfig(GUILD, 'roles', { seller: 'role' }, { actorId: 'administrator' });
  const checkpoint = await store.checkpointIfNeeded(2);
  assert.equal(checkpoint.sequence, 2); assert.equal(await store.checkpointIfNeeded(2), null);
  const oldDownloads = [...fixture.downloads.entries()];
  const retainedMessages = fixture.messages.size;
  await store.createSale(GUILD, saleData({ login: 'later' }));
  // The authenticated checkpoint is sufficient even if older attachments are no longer downloadable.
  for (const [url] of oldDownloads.slice(0, 2)) fixture.downloads.set(url, Buffer.from('Unavailable old attachment'));
  fixture.downloaded.length = 0;
  const reloaded = fixture.store(); await reloaded.load();
  assert.equal(fixture.downloaded.length, 2);
  assert.equal((await reloaded.listRecords(GUILD, 'vendas')).length, 2);
  assert.equal(await reloaded.getConfig(GUILD, 'roles').then((roles) => roles.seller), 'role');
  assert.ok(fixture.messages.size > retainedMessages);
  assert.equal((await reloaded.createSale(GUILD, saleData({ login: 'third' }))).id, 'VEN-003');
  assert.equal((await reloaded.listAudit(GUILD)).find((entry) => entry.action === 'config.updated').actorId, 'administrator');
});

test('checkpoint corruption and post-checkpoint event corruption stop reconstruction', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  await store.createSale(GUILD, saleData()); await store.checkpoint();
  await store.setConfig(GUILD, 'roles', { seller: 'role' });
  const latestUrl = [...fixture.downloads.keys()].at(-1);
  const event = JSON.parse(fixture.downloads.get(latestUrl)); event.sequence += 1;
  fixture.downloads.set(latestUrl, Buffer.from(JSON.stringify(event)));
  await assert.rejects(fixture.store().load(), /autenticação/);
  const snapshotUrl = [...fixture.downloads.keys()][1];
  fixture.downloads.set(snapshotUrl, Buffer.from(JSON.stringify({ format: 'unlock-bot-snapshot-v1', guildId: GUILD, encrypted: true, data: 'invalid' })));
  await assert.rejects(fixture.store().load(), /decifrar/);
});

test('trade validates linked tools and future expirations cannot be released', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const sale = await store.createSale(GUILD, saleData({ registeredAt: '2090-01-03T15:00:00.000Z' }));
  await assert.rejects(store.createTrade(GUILD, { client: 'Client', tool: 'invented tool' }), /Ferramenta inválida/);
  await assert.rejects(store.createTrade(GUILD, { client: 'Client', tool: 'TSM Tool', saleId: sale.id }), /outra ferramenta/);
  const trade = await store.createTrade(GUILD, { client: 'Client', tool: 'Unlock Tool', saleId: sale.id, reason: 'Troca confirmada' });
  assert.equal(trade.id, 'TRC-001');
  const [expiration] = await store.expireSales(GUILD, '2090-01-04T10:00:00.000Z');
  const result = await store.releaseAccounts(GUILD, { expirationIds: [expiration.id], newPassword: 'new' });
  assert.equal(result.changed.length, 0); assert.match(result.errors[0].message, /ainda não atingiu/);
});


test('ad expenses can be registered for past dates, edited, sorted and recovered after reload', async () => {
  const fixture = discordFixture(); const store = fixture.store(); await store.load();
  const old = await store.createAdExpense(GUILD, { amountCents: 3250, date: '2026-09-20', description: 'Meta Ads', actorId: 'admin', registeredAt: '2026-10-09T10:00:00Z' });
  assert.equal(old.id, 'ADS-001');
  assert.equal(old.amountCents, 3250);
  const updated = await store.updateAdExpense(GUILD, { id: old.id, amountCents: 4500, date: '2026-09-19', description: 'Campanha corrigida', actorId: 'admin', updatedAt: '2026-10-09T11:00:00Z' });
  assert.equal(updated.amountCents, 4500);
  assert.equal(updated.date, '2026-09-19');
  assert.equal((await store.listAdExpenses(GUILD))[0].id, 'ADS-001');
  const reloaded = fixture.store(); await reloaded.load();
  assert.deepEqual(await reloaded.listAdExpenses(GUILD), [updated]);
  await assert.rejects(store.createAdExpense(GUILD, { amountCents: 100, date: '2026-02-30' }), /Data inválida/);
  await assert.rejects(store.updateAdExpense(GUILD, { id: old.id }), /pelo menos um campo/);
});

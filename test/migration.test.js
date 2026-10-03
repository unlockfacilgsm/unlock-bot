'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const { migrateLegacy, parseLegacyRecord } = require('../src/migration');
const { Store } = require('../src/store');
const { TOOLS } = require('../src/catalog');

function legacyMessage(id, channelId, content, date = '2026-10-01T12:00:00Z', author = 'bot') {
  return { id, channelId, content, createdTimestamp: +new Date(date), author: { id: author }, url: `https://discord.com/channels/guild/${channelId}/${id}` };
}
function saleContent(id = 'VEN-001', login = 'login', changed = false) {
  return ['━━━━━━━━━━━━━━━━━━━━━━', '📌 VENDA', `🔖 ID: ${id}`, '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '📦 PLANO: 12 horas', `🔐 LOGIN: \`${login}\``, '🔑 SENHA: `senha-antiga`', '⏰ VENCIMENTO: 01/10/2026 23:00', '📅 REGISTRADO EM: 01/10/2026 11:00', ...(changed ? ['🔄 STATUS: SENHA TROCADA'] : []), '━━━━━━━━━━━━━━━━━━━━━━'].join('\n');
}

function fixture(legacyChannels) {
  const messages = new Map(), downloads = new Map();
  let next = 0;
  const data = {
    id: `data-${Math.random()}`, guildId: 'guild', client: { user: { id: 'bot' } },
    messages: { async fetch({ limit = 100, before } = {}) {
      return new Map([...messages.values()].filter(message => !before || +message.id < +before).sort((a, b) => +b.id - +a.id).slice(0, limit).map(message => [message.id, message]));
    } },
    async send(options) {
      const id = String(++next), attachments = new Map();
      for (const [index, file] of (options.files || []).entries()) {
        const url = `memory://${data.id}/${id}/${index}`;
        downloads.set(url, file.attachment); attachments.set(String(index), { name: file.name, url });
      }
      const message = { id, content: options.content, author: { id: 'bot' }, attachments, createdTimestamp: next };
      messages.set(id, message); return message;
    }
  };
  const channels = legacyChannels.map(({ id, name, messages: history }) => ({
    id, name, type: ChannelType.GuildText,
    messages: { async fetch({ limit = 100, before } = {}) {
      const list = [...history].reverse();
      const offset = before ? list.findIndex(message => message.id === before) + 1 : 0;
      return new Map(list.slice(offset, offset + limit).map(message => [message.id, message]));
    } }
  }));
  const cache = new Map(channels.map(channel => [channel.id, channel]));
  cache.set(data.id, data);
  const guild = { id: 'guild', channels: { cache, async fetch() { return cache; } } };
  const archive = [];
  const transport = { async archiveLegacy(g, channel) { archive.push(channel.id); if (!channel.name.startsWith('arquivo-')) channel.name = `arquivo-${channel.name}`; } };
  const store = new Store({ channel: data, guildId: guild.id, botId: 'bot', encryptionKey: Buffer.alloc(32, 13), downloadAttachment: async url => downloads.get(url) });
  const run = async () => migrateLegacy(guild, { client: { user: { id: 'bot' } }, store, transport, catalog: TOOLS, clock: () => new Date('2026-10-02T12:00:00Z') });
  return { store, run, archive, messages, downloads };
}

test('migration imports each record type, estimates historical prices and is idempotent', async () => {
  const sale = legacyMessage('100', 'sales', saleContent());
  const expiration = legacyMessage('101', 'expired', ['📌 VENCIMENTO', '🔖 ID: VENC-001', '🔖 VENDA ID: VEN-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '⏰ VENCIMENTO: 01/10/2026 23:00', `🔗 VENDA: ${sale.url}`].join('\n'));
  const renewal = legacyMessage('102', 'renew', ['📌 RENOVAÇÃO', '🔖 ID: REN-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '📦 NOVO PLANO: 3 meses', '⏰ NOVO VENCIMENTO: 01/01/2027 23:00', '📅 REGISTRADO EM: 01/10/2026 12:00', `🔗 VENDA: ${sale.url}`].join('\n'));
  const trade = legacyMessage('103', 'trade', ['📌 TROCA', '🔖 ID: TRC-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '📝 MOTIVO: suporte', '📄 OBSERVAÇÃO: observação', '📅 REGISTRADO EM: 01/10/2026 12:00'].join('\n'));
  const f = fixture([
    { id: 'sales', name: '💰・vendas', messages: [sale] }, { id: 'expired', name: '⏰・vencimentos', messages: [expiration] },
    { id: 'renew', name: '♻️・renovações', messages: [renewal] }, { id: 'trade', name: '🔄・trocas', messages: [trade] }
  ]);
  await f.store.load();
  const report = await f.run(); assert.deepEqual(report.errors, []);
  assert.equal(report.imported.vendas, 1); assert.equal(report.imported.renovacoes, 1); assert.equal(report.imported.vencimentos, 1); assert.equal(report.imported.trocas, 1);
  const saved = await f.store.getRecord('guild', 'vendas', 'VEN-001');
  assert.equal(saved.priceCents, 1000); assert.equal(saved.priceEstimated, true); assert.equal(saved.password, undefined);
  assert.equal(saved.messageId, undefined); assert.equal(saved.legacyMessageId, '100');
  assert.equal((await f.store.getRecord('guild', 'renovacoes', 'REN-001')).saleId, saved.id);
  assert.equal(f.archive.length, 4);
  const repeat = await f.run(); assert.equal(repeat.alreadyImported, 4); assert.equal(repeat.imported.vendas, 0);
  assert.equal((await f.store.listRecords('guild', 'vendas')).length, 1);
  assert.ok([...f.downloads.values()].every(buffer => !buffer.toString().includes('senha-antiga')));
});

test('other users cannot forge legacy sales', async () => {
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [legacyMessage('100', 'sales', saleContent(), undefined, 'human')] }]);
  await f.store.load(); const report = await f.run();
  assert.equal(report.ignoredOtherAuthors, 1); assert.equal(report.imported.vendas, 0);
  assert.equal((await f.store.listAccounts('guild')).length, 0);
});

test('an old marked release without delivered credentials stays occupied', async () => {
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [legacyMessage('100', 'sales', saleContent('VEN-001', 'login', true))] }]);
  await f.store.load(); const report = await f.run();
  assert.equal(report.errors.length, 0);
  const sale = await f.store.getRecord('guild', 'vendas', 'VEN-001');
  assert.equal(sale.status, 'expired'); assert.equal(sale.migrationReleaseUnverified, true);
  const account = await f.store.getAccount('guild', sale.accountId); assert.equal(account.status, 'occupied');
});

test('a verified historical free publication imports exact credentials', async () => {
  const f = fixture([
    { id: 'sales', name: '💰・vendas', messages: [legacyMessage('100', 'sales', saleContent('VEN-001', 'login', true))] },
    { id: 'free', name: '🆓・unlock-tool', messages: [legacyMessage('101', 'free', 'login: $&`new-password ', '2026-10-02T03:00:00Z')] }
  ]);
  await f.store.load(); const report = await f.run(); assert.deepEqual(report.errors, []);
  const sale = await f.store.getRecord('guild', 'vendas', 'VEN-001'); assert.equal(sale.status, 'released');
  const account = await f.store.getAccount('guild', sale.accountId);
  assert.equal(account.status, 'available'); assert.equal(account.password, ' $&`new-password ');
});

test('historical free messages never overwrite a newer occupied sale', async () => {
  const first = legacyMessage('100', 'sales', saleContent('VEN-001', 'login', true));
  const newerContent = saleContent('VEN-002').replace('01/10/2026 23:00', '02/10/2026 23:00').replace('01/10/2026 11:00', '02/10/2026 11:00').replace('senha-antiga', 'senha-nova-venda');
  const f = fixture([
    { id: 'sales', name: '💰・vendas', messages: [first, legacyMessage('102', 'sales', newerContent, '2026-10-02T14:00:00Z')] },
    { id: 'free', name: '🆓・unlock-tool', messages: [legacyMessage('101', 'free', 'login:free-old-password', '2026-10-02T03:00:00Z')] }
  ]);
  await f.store.load(); await f.run();
  const account = (await f.store.listAccounts('guild'))[0];
  assert.equal(account.activeSaleId, 'VEN-002'); assert.equal(account.status, 'occupied'); assert.equal(account.password, 'senha-nova-venda');
});

test('duplicate legacy sale IDs remain separate and URL-linked expiration is preserved', async () => {
  const a = legacyMessage('100', 'sales', saleContent('VEN-001', 'one'));
  const b = legacyMessage('101', 'sales', saleContent('VEN-001', 'two'));
  const expiry = legacyMessage('102', 'expired', ['📌 VENCIMENTO', '🔖 ID: VENC-001', '🔖 VENDA ID: VEN-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '⏰ VENCIMENTO: 01/10/2026 23:00', `🔗 VENDA: ${b.url}`].join('\n'));
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [a, b] }, { id: 'expired', name: '⏰・vencimentos', messages: [expiry] }]);
  await f.store.load(); const report = await f.run(); assert.deepEqual(report.errors, []); assert.equal(report.duplicateIds.length, 1);
  assert.equal((await f.store.listRecords('guild', 'vendas')).length, 2);
  assert.equal((await f.store.getRecord('guild', 'vencimentos', 'VENC-001')).saleId, 'VEN-LEGACY-101');
  const repeat = await f.run(); assert.equal(repeat.alreadyImported, 3);
});

test('duplicate labeled fields require review and prevent archiving', async () => {
  const content = `${saleContent()}\n👤 CLIENTE: injected`;
  assert.throws(() => parseLegacyRecord(legacyMessage('100', 'sales', content), TOOLS), /duplicado/);
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [legacyMessage('100', 'sales', content)] }]);
  await f.store.load(); const report = await f.run();
  assert.equal(report.errors.length, 1); assert.equal(f.archive.length, 0);
});

test('conflicting legacy occupied accounts are reported and latest assignment is retained', async () => {
  const a = legacyMessage('100', 'sales', saleContent('VEN-001'));
  const b = legacyMessage('101', 'sales', saleContent('VEN-002').replace('01/10/2026 11:00', '01/10/2026 12:00'));
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [a, b] }]);
  await f.store.load(); const report = await f.run(); assert.equal(report.conflicts.length, 1);
  assert.equal((await f.store.listAccounts('guild'))[0].activeSaleId, 'VEN-002');
  assert.equal((await f.store.getRecord('guild', 'vendas', 'VEN-001')).migrationConflict, true);
});

test('historical plans removed from current catalog remain importable with unknown price', async () => {
  const content = saleContent().replace('Unlock Tool', 'AMT Tool').replace('12 horas', '12 meses');
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [legacyMessage('100', 'sales', content)] }]);
  await f.store.load(); const report = await f.run(); assert.deepEqual(report.errors, []);
  const sale = await f.store.getRecord('guild', 'vendas', 'VEN-001');
  assert.equal(sale.plan, '12 meses'); assert.equal(sale.priceUnknown, true); assert.equal(sale.priceEstimated, true);
});

test('ambiguous duplicate sale IDs without a URL require review before archiving', async () => {
  const a = legacyMessage('100', 'sales', saleContent('VEN-001', 'one'));
  const b = legacyMessage('101', 'sales', saleContent('VEN-001', 'two'));
  const expiry = legacyMessage('102', 'expired', ['📌 VENCIMENTO', '🔖 ID: VENC-001', '🔖 VENDA ID: VEN-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '⏰ VENCIMENTO: 01/10/2026 23:00'].join('\n'));
  const f = fixture([{ id: 'sales', name: '💰・vendas', messages: [a, b] }, { id: 'expired', name: '⏰・vencimentos', messages: [expiry] }]);
  await f.store.load(); const report = await f.run();
  assert.equal(report.errors.length, 1); assert.equal(f.archive.length, 0);
  assert.equal((await f.store.getRecord('guild', 'vencimentos', 'VENC-001')).migrationOrphan, true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { parseLegacyRecord } = require('../src/migration');
const { auditLegacy } = require('../src/legacy-audit');
const { cleanupLegacy } = require('../src/legacy-cleanup');
const { SNAPSHOT_FORMAT } = require('../src/store');
const catalog = require('../src/catalog');

function fixture({ missing = false, passwordGap = false, corruptBackup = false } = {}) {
  const events = [], downloads = new Map();
  const cache = new Map();
  const message = { id: 'old-message', channelId: 'old-channel', author: { id: 'bot' }, attachments: new Map(),
    content: ['📌 VENDA', '🔖 ID: VEN-001', '👤 CLIENTE: Cliente', '🛠️ FERRAMENTA: Unlock Tool', '📦 PLANO: 12 horas', '🔐 LOGIN: `login`', '🔑 SENHA: `original-password`', '⏰ VENCIMENTO: 03/10/2026 03:02', '📅 REGISTRADO EM: 02/10/2026 15:02'].join('\n') };
  const old = { id: 'old-channel', name: 'arquivo-💰・vendas', parentId: 'old-category', type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => new PermissionsBitField(P.ManageChannels),
    messages: { async fetch() { return new Map([[message.id, message]]); } },
    async delete() { events.push('delete-channel'); cache.delete(this.id); }
  };
  const category = { id: 'old-category', name: '📁 UNLOCK FÁCIL', type: ChannelType.GuildCategory,
    async delete() { events.push('delete-category'); cache.delete(this.id); } };
  const backups = { id: 'backup', name: 'backups', type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(0n),
    async send(payload) {
      events.push('upload-backup');
      const attachments = new Map();
      for (const file of payload.files) {
        const url = `memory://${file.name}`; downloads.set(url, corruptBackup ? Buffer.from('bad') : file.attachment);
        attachments.set(file.name, { name: file.name, url });
      }
      return { url: 'https://discord.com/channels/guild/backup/message', attachments };
    }
  };
  for (const channel of [old, category, backups]) cache.set(channel.id, channel);
  const guild = { id: 'guild', roles: { everyone: { id: 'everyone' } }, members: { me: { id: 'bot' } },
    channels: { cache, async fetch() { return cache; } } };
  const canonical = parseLegacyRecord(message, catalog.TOOLS);
  delete canonical.password;
  let password = passwordGap ? undefined : 'original-password';
  const store = { channel: { id: 'data' },
    async getConfig(gid, key) { return key === 'channels' ? { vendas: 'current', backups: 'backup' } : { staff: 'current-category' }; },
    async listRecords(gid, type) { return !missing && type === 'vendas' ? [structuredClone(canonical)] : []; },
    async listAccounts() { return []; },
    async getDisplayRecord() { return { ...canonical, password }; },
    async transaction(callback) { return structuredClone(await callback()); },
    async preserveLegacySalePassword(gid, { source }) { events.push('preserve-password'); password = source.password; },
    async exportSnapshot() { return Buffer.from(JSON.stringify({ format: SNAPSHOT_FORMAT, guildId: guild.id, encrypted: true, data: 'ciphertext' })); }
  };
  return { guild, client: { user: { id: 'bot' } }, store, encryptionKey: Buffer.alloc(32, 5), events, downloads, canonical };
}

test('a missing sale blocks backup and all channel deletions', async () => {
  const f = fixture({ missing: true });
  const result = await cleanupLegacy(f);
  assert.equal(result.report.missingRecords.length, 1);
  assert.deepEqual(result.deleted, []); assert.deepEqual(f.events, []);
});

test('historical passwords are preserved and both remote backups are verified before deleting only legacy channels', async () => {
  const f = fixture({ passwordGap: true });
  const originalFetch = global.fetch;
  global.fetch = async url => { f.events.push('verify-backup'); return { ok: true, arrayBuffer: async () => f.downloads.get(url) }; };
  try {
    const result = await cleanupLegacy(f);
    assert.equal(result.report.matchedSales, 1); assert.equal(result.preservedPasswords, 1);
    assert.equal(result.deleted.length, 2);
    assert.deepEqual(f.events, ['preserve-password', 'upload-backup', 'verify-backup', 'verify-backup', 'delete-channel', 'delete-category']);
    assert.ok(f.guild.channels.cache.has('backup'));
    assert.ok([...f.downloads.values()].every(bytes => !bytes.toString().includes('original-password')));
  } finally { global.fetch = originalFetch; }
});

test('a corrupted remote backup prevents deletion', async () => {
  const f = fixture({ corruptBackup: true });
  const originalFetch = global.fetch;
  global.fetch = async url => ({ ok: true, arrayBuffer: async () => f.downloads.get(url) });
  try {
    await assert.rejects(cleanupLegacy(f), /não corresponde/);
    assert.ok(!f.events.includes('delete-channel'));
    assert.ok(f.guild.channels.cache.has('old-channel'));
  } finally { global.fetch = originalFetch; }
});

test('comparison detects changed dates and passwords without printing their values', async () => {
  const f = fixture(); f.canonical.expiresAt = '2026-10-04T06:02:00.000Z';
  const { report } = await auditLegacy(f);
  assert.equal(report.ok, false);
  assert.deepEqual(report.differences[0].fields, ['expiresAt']);
  assert.ok(!JSON.stringify(report).includes('original-password'));
});

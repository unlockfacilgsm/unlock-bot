'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChannelType, PermissionsBitField, PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const { start } = require('../index');
const { Store } = require('../src/store');

function fixture() {
  const guildId = '123456789012345678';
  const botId = '223456789012345678';
  const key = Buffer.alloc(32, 17);
  const messages = new Map();
  let sequence = 0;
  const guild = {
    id: guildId,
    members: { me: { id: botId, permissions: new PermissionsBitField(P.Administrator) } },
    roles: { everyone: { id: guildId }, cache: new Map() }
  };
  const data = {
    id: '323456789012345678', name: '🤖・dados-bot', type: ChannelType.GuildText,
    guildId, topic: 'UF4: armazenamento criptografado do bot; não apague mensagens.',
    permissionsFor: () => guild.members.me.permissions,
    permissionOverwrites: {
      cache: new Map([
        [guildId, { id: guildId, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel }],
        [botId, { id: botId, type: OverwriteType.Member, allow: P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.AttachFiles, deny: 0n }]
      ]),
      async set() { assert.fail('An existing private channel must not need startup permission changes.'); }
    },
    messages: { async fetch({ limit = 100, before } = {}) {
      return new Map([...messages.values()].filter(message => !before || BigInt(message.id) < BigInt(before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, limit).map(message => [message.id, message]));
    } },
    async send(payload) {
      const id = String(++sequence);
      const attachments = new Map((payload.files || []).map(file => [file.name, {
        name: file.name, url: `data:application/json;base64,${Buffer.from(file.attachment).toString('base64')}`
      }]));
      const message = { id, content: payload.content, attachments, author: { id: botId }, createdTimestamp: sequence };
      messages.set(id, message);
      return message;
    }
  };
  const cache = new Map([[data.id, data]]);
  guild.channels = { cache, async fetch(id) { return id ? cache.get(id) : cache; } };
  class Client extends EventEmitter {
    constructor() { super(); this.user = { id: botId, tag: 'TestBot' }; this.guilds = { cache: new Map([[guildId, guild]]) }; }
    async login() { queueMicrotask(() => this.emit('clientReady', this)); }
    destroy() { this.destroyed = true; }
  }
  const client = new Client();
  const errors = [];
  const logger = { log() {}, error(message) { errors.push(message); } };
  const env = { DISCORD_TOKEN: 'test-token', GUILD_ID: guildId, ENCRYPTION_KEY: key.toString('base64') };
  return { guild, data, client, errors, logger, env, key };
}

test('partial setup task failure leaves bot online to repair configuration', async () => {
  const f = fixture();
  const store = new Store({ channel: f.data, guildId: f.guild.id, botId: f.client.user.id, encryptionKey: f.key });
  await store.load();
  await store.setConfig(f.guild.id, 'channels', { painel: 'missing-panel', backups: 'missing-backup' });
  const running = await start(f);
  try {
    assert.ok(running.app);
    assert.ok(!f.client.destroyed);
    assert.match(f.errors.join('\n'), /Verificação pendente/);
    assert.match(f.errors.join('\n'), /backup/i);
    assert.equal((await running.store.getConfig(f.guild.id, 'channels')).painel, 'missing-panel');
  } finally { await running.stop(); }
});

test('incomplete setup waits without repeatedly attempting missing backup channels', async () => {
  const f = fixture();
  const store = new Store({ channel: f.data, guildId: f.guild.id, botId: f.client.user.id, encryptionKey: f.key });
  await store.load();
  await store.setConfig(f.guild.id, 'channels', { painel: 'missing-panel' });
  const running = await start(f);
  try {
    await running.app.tick(f.guild);
    assert.deepEqual(f.errors, []);
    assert.ok(!f.client.destroyed);
  } finally { await running.stop(); }
});

test('unreadable data channel fails before loading and reports startup stage', async () => {
  const f = fixture();
  f.data.permissionsFor = () => new PermissionsBitField(0n);
  await assert.rejects(start(f), error => {
    assert.equal(error.code, 'BOT_MISSING_PERMISSIONS');
    assert.equal(error.botContext, 'acesso ao canal de dados');
    assert.match(error.message, /Ver Canal/);
    return true;
  });
  assert.ok(f.client.destroyed);
});

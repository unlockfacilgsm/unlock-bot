'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, Routes, ChannelType } = require('discord.js');
const { diagnose, renderDiagnostic, REQUIRED } = require('../scripts/doctor');
const { CHANNEL_NAMES } = require('../src/transport');

const GUILD = '100000000000000001', BOT = '100000000000000002', BOT_ROLE = '100000000000000003';
const HUMAN_ROLE = '100000000000000004', DATA = '100000000000000005';
const ALL = REQUIRED.reduce((bits, permission) => bits | P[permission.name], 0n);
const env = { DISCORD_TOKEN: 'do-not-print-token', GUILD_ID: GUILD };

function fixture({ permissions = ALL, overwrites = [], humanRoles = true, channels, owner } = {}) {
  const calls = [];
  const data = new Map([
    [Routes.user('@me'), { id: BOT, username: 'Test bot' }],
    [Routes.guild(GUILD), { id: GUILD, name: 'Equipe', owner_id: owner || '100000000000000099' }],
    [Routes.guildRoles(GUILD), [
      { id: GUILD, name: '@everyone', managed: false, position: 0, permissions: '0' },
      { id: BOT_ROLE, name: 'Bot integration', managed: true, position: 10, permissions: permissions.toString() },
      ...(humanRoles ? [{ id: HUMAN_ROLE, name: 'Vendedores', managed: false, position: 1, permissions: '0' }] : []),
    ]],
    [Routes.guildMember(GUILD, BOT), { user: { id: BOT }, roles: [BOT_ROLE] }],
    [Routes.guildChannels(GUILD), channels || [{ id: DATA, name: CHANNEL_NAMES.dados, type: ChannelType.GuildText,
      topic: 'UF4: armazenamento criptografado do bot; não apague mensagens.', permission_overwrites: overwrites }]],
  ]);
  return { data, calls, rest: { async get(route) { calls.push({ method: 'GET', route }); return data.get(route); } } };
}

test('doctor reads only identity and server metadata and lists valid team roles', async () => {
  const mock = fixture();
  const report = await diagnose(env, mock.rest);
  assert.equal(report.ok, true); assert.deepEqual(report.humanRoles.map(role => role.id), [HUMAN_ROLE]);
  assert.equal(report.dataChannel.id, DATA);
  assert.deepEqual(mock.calls.map(call => call.route).sort(), [Routes.user('@me'), Routes.guild(GUILD), Routes.guildRoles(GUILD),
    Routes.guildMember(GUILD, BOT), Routes.guildChannels(GUILD)].sort());
  assert.equal(mock.calls.every(call => call.method === 'GET' && !call.route.includes('/messages')), true);
  const output = renderDiagnostic(report);
  assert.match(output, /CARGOS/); assert.match(output, /não @usuários/);
  assert.equal(output.includes(env.DISCORD_TOKEN), false); assert.equal(JSON.stringify(report).includes(env.DISCORD_TOKEN), false);
});

test('doctor highlights missing ManageRoles and absence of a human team role', async () => {
  const mock = fixture({ permissions: ALL & ~P.ManageRoles, humanRoles: false });
  const report = await diagnose(env, mock.rest);
  assert.equal(report.ok, false); assert.equal(report.humanRoles.length, 0);
  assert.equal(report.guildPermissions.find(permission => permission.name === 'ManageRoles').allowed, false);
  assert.match(renderDiagnostic(report), /FALTA Gerenciar cargos \(ManageRoles\)/);
  assert.match(renderDiagnostic(report), /Nenhum cargo de equipe válido/);
});

test('channel permission overwrites apply everyone, combined roles and then member overrides', async () => {
  const mock = fixture({ overwrites: [
    { id: GUILD, type: 0, deny: (P.ViewChannel | P.SendMessages).toString(), allow: '0' },
    { id: BOT_ROLE, type: 0, deny: P.AttachFiles.toString(), allow: P.ViewChannel.toString() },
    { id: BOT, type: 1, deny: P.EmbedLinks.toString(), allow: (P.SendMessages | P.AttachFiles).toString() },
  ] });
  const report = await diagnose(env, mock.rest);
  assert.equal(report.guildPermissions.every(permission => permission.allowed), true);
  assert.equal(report.dataChannel.permissions.find(permission => permission.name === 'ViewChannel').allowed, true);
  assert.equal(report.dataChannel.permissions.find(permission => permission.name === 'SendMessages').allowed, true);
  assert.equal(report.dataChannel.permissions.find(permission => permission.name === 'AttachFiles').allowed, true);
  assert.equal(report.dataChannel.permissions.find(permission => permission.name === 'EmbedLinks').allowed, false);
  assert.equal(report.ok, false); assert.equal(report.issues[0].code, 'MISSING_CHANNEL_PERMISSIONS');
});

test('administrator bypasses channel overwrites and server owner has all permissions', async () => {
  const administrator = fixture({ permissions: P.Administrator, overwrites: [{ id: BOT, type: 1, deny: ALL.toString(), allow: '0' }] });
  assert.equal((await diagnose(env, administrator.rest)).ok, true);
  const owner = fixture({ permissions: 0n, owner: BOT });
  assert.equal((await diagnose(env, owner.rest)).ok, true);
});

test('doctor discovers renamed marked data channel and requires an ID for ambiguity', async () => {
  const renamed = fixture({ channels: [{ id: DATA, type: ChannelType.GuildText, name: 'renamed-data', topic: 'UF4: armazenamento criptografado test', permission_overwrites: [] }] });
  assert.equal((await diagnose(env, renamed.rest)).dataChannel.name, 'renamed-data');
  const ambiguous = fixture({ channels: [
    { id: DATA, type: ChannelType.GuildText, name: CHANNEL_NAMES.dados, topic: null },
    { id: '100000000000000006', type: ChannelType.GuildText, name: CHANNEL_NAMES.dados, topic: null },
  ] });
  const report = await diagnose(env, ambiguous.rest);
  assert.equal(report.ok, false); assert.equal(report.issues[0].code, 'AMBIGUOUS_DATA_CHANNEL');
  assert.equal((await diagnose({ ...env, DISCORD_DATA_CHANNEL_ID: DATA }, ambiguous.rest)).dataChannel.id, DATA);
});

test('doctor rejects invalid configured IDs and managed team roles without reading messages', async () => {
  const mock = fixture();
  const wrongChannel = await diagnose({ ...env, DISCORD_DATA_CHANNEL_ID: HUMAN_ROLE }, mock.rest);
  assert.equal(wrongChannel.ok, false); assert.equal(wrongChannel.issues[0].code, 'INVALID_DATA_CHANNEL');
  const managedRole = await diagnose({ ...env, ADMIN_ROLE_ID: BOT_ROLE }, mock.rest);
  assert.equal(managedRole.issues[0].code, 'INVALID_HUMAN_ROLE');
  const userRole = await diagnose({ ...env, SELLER_ROLE_ID: BOT }, mock.rest);
  assert.equal(userRole.issues[0].code, 'INVALID_HUMAN_ROLE');
});

test('doctor validates credentials before accessing REST and propagates failures for sanitized reporting', async () => {
  const mock = fixture();
  await assert.rejects(diagnose({ ...env, DISCORD_TOKEN: ' ' }, mock.rest), /DISCORD_TOKEN/);
  await assert.rejects(diagnose({ ...env, GUILD_ID: 'not-an-id' }, mock.rest), /GUILD_ID/);
  assert.equal(mock.calls.length, 0);
  const forbidden = Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
  mock.rest.get = async route => { if (route === Routes.user('@me')) return { id: BOT }; throw forbidden; };
  await assert.rejects(diagnose(env, mock.rest), error => error === forbidden);
});

test('missing initial data channel remains a clear setup instruction without making changes', async () => {
  const mock = fixture({ channels: [] });
  const report = await diagnose(env, mock.rest);
  assert.equal(report.ok, true); assert.equal(report.dataChannel, null);
  assert.match(renderDiagnostic(report), /canal de dados ainda não existe/);
  assert.equal(mock.calls.length, 5);
});

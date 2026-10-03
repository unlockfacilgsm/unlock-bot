'use strict';

const { REST, Routes, PermissionFlagsBits: P, PermissionsBitField, ChannelType } = require('discord.js');
const { CHANNEL_NAMES } = require('../src/transport');

const REQUIRED = Object.freeze([
  { name: 'ViewChannel', label: 'Ver canais' },
  { name: 'ReadMessageHistory', label: 'Ler histórico de mensagens' },
  { name: 'SendMessages', label: 'Enviar mensagens' },
  { name: 'AttachFiles', label: 'Anexar arquivos' },
  { name: 'EmbedLinks', label: 'Inserir links' },
  { name: 'ManageChannels', label: 'Gerenciar canais' },
  { name: 'ManageRoles', label: 'Gerenciar cargos' },
]);

function validateEnvironment(env) {
  if (typeof env.DISCORD_TOKEN !== 'string' || !env.DISCORD_TOKEN.trim()) throw new Error('Preencha DISCORD_TOKEN no .env antes de executar o diagnóstico.');
  if (!/^\d{1,25}$/.test(env.GUILD_ID || '')) throw new Error('GUILD_ID deve conter o ID numérico do servidor.');
  for (const key of ['DISCORD_DATA_CHANNEL_ID', 'ADMIN_ROLE_ID', 'SELLER_ROLE_ID']) {
    if (env[key] && !/^\d{1,25}$/.test(env[key])) throw new Error(`${key} deve conter um ID numérico do Discord.`);
  }
}

function guildPermissions(guild, roles, member, botId) {
  let permissions = 0n;
  const memberRoles = new Set(member.roles || []);
  memberRoles.add(guild.id);
  for (const role of roles) if (memberRoles.has(role.id)) permissions |= BigInt(role.permissions || '0');
  if (guild.owner_id === botId || (permissions & P.Administrator) === P.Administrator) return PermissionsBitField.All;
  return permissions;
}

function channelPermissions(base, channel, guildId, member, botId) {
  if ((base & P.Administrator) === P.Administrator) return PermissionsBitField.All;
  let permissions = base;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find(overwrite => overwrite.id === guildId && Number(overwrite.type) === 0);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny || '0')) | BigInt(everyone.allow || '0');
  const memberRoles = new Set(member.roles || []);
  let deny = 0n, allow = 0n;
  for (const overwrite of overwrites) {
    if (Number(overwrite.type) !== 0 || overwrite.id === guildId || !memberRoles.has(overwrite.id)) continue;
    deny |= BigInt(overwrite.deny || '0'); allow |= BigInt(overwrite.allow || '0');
  }
  permissions = (permissions & ~deny) | allow;
  const own = overwrites.find(overwrite => overwrite.id === botId && Number(overwrite.type) === 1);
  if (own) permissions = (permissions & ~BigInt(own.deny || '0')) | BigInt(own.allow || '0');
  return permissions;
}

function checks(bitfield) {
  return REQUIRED.map(permission => ({ ...permission, allowed: (bitfield & P[permission.name]) === P[permission.name] }));
}

function isDataChannel(channel) {
  return channel.type === ChannelType.GuildText && (channel.topic?.startsWith('UF4: armazenamento criptografado') || channel.name === CHANNEL_NAMES.dados);
}

async function diagnose(env = process.env, rest) {
  validateEnvironment(env);
  const client = rest || new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  if (typeof client.get !== 'function') throw new Error('Cliente REST inválido.');
  // Deliberately read metadata only; this function never requests messages or writes to Discord.
  const bot = await client.get(Routes.user('@me'));
  if (!bot?.id) throw new Error('O Discord não retornou a identidade do bot.');
  const results = await Promise.allSettled([
    client.get(Routes.guild(env.GUILD_ID)),
    client.get(Routes.guildRoles(env.GUILD_ID)),
    client.get(Routes.guildMember(env.GUILD_ID, bot.id)),
    client.get(Routes.guildChannels(env.GUILD_ID)),
  ]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [guild, roles, member, channels] = results.map(result => result.value);
  if (!guild?.id || guild.id !== env.GUILD_ID || !Array.isArray(roles) || !member || !Array.isArray(channels)) {
    throw new Error('O Discord retornou metadados incompletos para este servidor.');
  }
  const base = guildPermissions(guild, roles, member, bot.id);
  const report = {
    ok: true, bot: { id: bot.id, name: bot.username || 'Bot' }, guild: { id: guild.id, name: guild.name },
    guildPermissions: checks(base), dataChannel: null,
    humanRoles: roles.filter(role => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position || String(a.name).localeCompare(String(b.name)))
      .map(role => ({ id: role.id, name: role.name, position: role.position,
        administrator: (BigInt(role.permissions || '0') & P.Administrator) === P.Administrator })),
    issues: [], warnings: [],
  };
  const missingGuild = report.guildPermissions.filter(permission => !permission.allowed);
  if (missingGuild.length) report.issues.push({ code: 'MISSING_GUILD_PERMISSIONS',
    message: `Faltam permissões do bot no servidor: ${missingGuild.map(permission => `${permission.label} (${permission.name})`).join(', ')}.` });
  if (!report.humanRoles.length) report.warnings.push('Nenhum cargo de equipe válido foi encontrado. Crie cargos para administrador e vendedor nas configurações do servidor.');
  for (const [key, description] of [['ADMIN_ROLE_ID', 'administrador'], ['SELLER_ROLE_ID', 'vendedor']]) {
    if (env[key] && !report.humanRoles.some(role => role.id === env[key])) report.issues.push({ code: 'INVALID_HUMAN_ROLE',
      message: `${key} não identifica um cargo válido de ${description}. Selecione um cargo de equipe; @everyone e cargos gerenciados por integrações não podem ser usados.` });
  }
  let selected;
  if (env.DISCORD_DATA_CHANNEL_ID) {
    selected = channels.find(channel => channel.id === env.DISCORD_DATA_CHANNEL_ID);
    if (!selected || !isDataChannel(selected)) report.issues.push({ code: 'INVALID_DATA_CHANNEL',
      message: 'DISCORD_DATA_CHANNEL_ID não identifica o canal de dados do bot neste servidor. Confira o ID e preserve o canal original.' });
  } else {
    const marked = channels.filter(channel => channel.type === ChannelType.GuildText && channel.topic?.startsWith('UF4: armazenamento criptografado'));
    const matches = marked.length ? marked : channels.filter(channel => channel.type === ChannelType.GuildText && channel.name === CHANNEL_NAMES.dados);
    if (matches.length > 1) report.issues.push({ code: 'AMBIGUOUS_DATA_CHANNEL',
      message: `Há vários canais de dados possíveis (${matches.map(channel => channel.id).join(', ')}). Informe DISCORD_DATA_CHANNEL_ID com o canal original.` });
    else selected = matches[0];
  }
  if (selected && isDataChannel(selected)) {
    const effective = checks(channelPermissions(base, selected, guild.id, member, bot.id));
    report.dataChannel = { id: selected.id, name: selected.name, permissions: effective };
    const missingChannel = effective.filter(permission => !permission.allowed);
    if (missingChannel.length) report.issues.push({ code: 'MISSING_CHANNEL_PERMISSIONS',
      message: `Faltam permissões efetivas do bot no canal de dados: ${missingChannel.map(permission => `${permission.label} (${permission.name})`).join(', ')}.` });
  } else if (!report.issues.some(issue => /DATA_CHANNEL/.test(issue.code))) {
    report.warnings.push('O canal de dados ainda não existe. /configurar poderá criar a estrutura depois de conceder as permissões e escolher os cargos da equipe.');
  }
  report.ok = report.issues.length === 0;
  return report;
}

function printable(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ');
}

function renderDiagnostic(report) {
  const lines = [
    'Diagnóstico do Discord (somente leitura)',
    `Bot: ${printable(report.bot.name)} (${report.bot.id})`,
    `Servidor: ${printable(report.guild.name)} (${report.guild.id})`,
    '', 'Permissões obrigatórias do bot no servidor:',
    ...report.guildPermissions.map(permission => `  ${permission.allowed ? 'OK' : 'FALTA'} ${permission.label} (${permission.name})`),
    '',
  ];
  if (report.dataChannel) {
    lines.push(`Canal de dados: ${printable(report.dataChannel.name)} (${report.dataChannel.id})`,
      ...report.dataChannel.permissions.map(permission => `  ${permission.allowed ? 'OK' : 'FALTA'} ${permission.label} (${permission.name})`), '');
  }
  lines.push('Cargos válidos para a equipe:');
  lines.push(...(report.humanRoles.length ? report.humanRoles.map(role =>
    `  ${printable(role.name)} (${role.id})${role.administrator ? ' — administrador do servidor' : ''}`) : ['  Nenhum.']));
  lines.push('', '/configurar seleciona CARGOS de administrador e vendedor, não @usuários.',
    'Os cargos da equipe são diferentes do cargo gerenciado pela própria integração do bot.');
  if (report.issues.length) lines.push('', 'Ajustes necessários:', ...report.issues.map(issue => `  ${printable(issue.message)}`));
  if (report.warnings.length) lines.push('', ...report.warnings.map(warning => `Aviso: ${printable(warning)}`));
  if (report.issues.some(issue => /PERMISSIONS/.test(issue.code))) lines.push('',
    'Nas configurações do servidor, conceda as permissões indicadas ao cargo da integração do bot e confira as substituições no canal de dados.');
  lines.push('', report.ok ? 'Diagnóstico concluído: permissões verificadas.' : 'Diagnóstico concluído: corrija os itens indicados antes de configurar o bot.');
  return lines.join('\n');
}

async function main() {
  require('dotenv').config({ quiet: true });
  try {
    const report = await diagnose(process.env);
    console.log(renderDiagnostic(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const { formatDiscordError } = require('../src/discord-errors');
    console.error(formatDiscordError(error, { env: process.env }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { diagnose, renderDiagnostic, guildPermissions, channelPermissions, REQUIRED, main };

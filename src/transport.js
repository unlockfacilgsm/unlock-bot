'use strict';

const crypto = require('node:crypto');
const {
  ChannelType, PermissionFlagsBits: P, PermissionsBitField, OverwriteType, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const CHANNEL_NAMES = {
  painel: '⚙️・painel', vendas: '💰・vendas', vencimentos: '⏰・vencimentos',
  trocas: '🔄・trocas', renovacoes: '♻️・renovações', comandos: '📖・comandos',
  dados: '🤖・dados-bot', backups: '💾・backups', auditoria: '📋・auditoria', alertas: '🔔・alertas', anuncios: '📣・gastos-anuncios'
};
const ADMIN_CHANNELS = new Set(['dados', 'backups', 'auditoria', 'anuncios']);
const NO_MENTIONS = { parse: [] };
const RECORD_SEPARATOR = '-----------------------------------------';
function recordBlock(content) {
  return `${RECORD_SEPARATOR}\n${content}\n${RECORD_SEPARATOR}`;
}

function recordPages(record, marker) {
  const block = renderRecord(record);
  const content = block.slice(RECORD_SEPARATOR.length + 1, -(RECORD_SEPARATOR.length + 1));
  return splitText(content, 1750).map((page, index) => recordBlock(`${page}${marker ? `\n${marker}${index ? `:${index}` : ''}` : ''}`));
}
const DATA_PERMISSIONS = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles];
const SETUP_PERMISSIONS = [P.ManageChannels, P.ManageRoles, ...DATA_PERMISSIONS, P.EmbedLinks];
const PERMISSION_NAMES = new Map([
  [P.ManageChannels, 'Gerenciar Canais'], [P.ManageRoles, 'Gerenciar Cargos'],
  [P.ViewChannel, 'Ver Canal'], [P.ReadMessageHistory, 'Ler Histórico de Mensagens'],
  [P.SendMessages, 'Enviar Mensagens'], [P.AttachFiles, 'Anexar Arquivos'], [P.EmbedLinks, 'Inserir Links']
]);

function missingPermissions(available, needed) {
  if (!available || typeof available.has !== 'function') throw new Error('Não foi possível verificar as permissões do bot; reconecte o bot e tente novamente.');
  return needed.filter(permission => !available.has(permission));
}

function permissionFailure(scope, missing) {
  const error = new Error(`O bot não tem ${missing.map(permission => PERMISSION_NAMES.get(permission)).join(', ')} ${scope}. Ajuste o cargo do bot e os bloqueios desse canal antes de tentar novamente. Nenhum canal ou histórico foi apagado.`);
  error.code = 'BOT_MISSING_PERMISSIONS';
  error.missingPermissions = missing.map(permission => PERMISSION_NAMES.get(permission));
  return error;
}

async function botMember(guild) {
  let member = guild.members?.me;
  if (!member?.permissions) {
    if (guild.members?.fetchMe) member = await guild.members.fetchMe();
    else throw new Error('Não foi possível conferir o membro do bot neste servidor; reconecte o bot.');
  }
  return member;
}

/** Check only the channels that the operation will actually manage. */
async function validateSetupPermissions(guild, { channels = [], manage = true } = {}) {
  const member = await botMember(guild);
  if (manage) {
    const missing = missingPermissions(member.permissions, SETUP_PERMISSIONS);
    if (missing.length) throw permissionFailure('no servidor', missing);
  }
  for (const channel of channels.filter(Boolean)) {
    const needed = manage ? (channel.type === ChannelType.GuildCategory ? [P.ViewChannel, P.ManageChannels, P.ManageRoles] : SETUP_PERMISSIONS) : DATA_PERMISSIONS;
    if (typeof channel.permissionsFor !== 'function') throw new Error(`Não foi possível conferir as permissões do bot no canal ${channel.name || channel.id}.`);
    const missing = missingPermissions(channel.permissionsFor(member), needed);
    if (missing.length) throw permissionFailure(`no canal ${channel.name || channel.id} (${channel.id})`, missing);
  }
  return member;
}

async function validateStaffRoles(guild, { adminRoleId, sellerRoleId } = {}) {
  for (const id of new Set([adminRoleId, sellerRoleId].filter(Boolean))) {
    if (id === guild.roles.everyone.id) throw new Error('O cargo @everyone não pode ser usado como administrador ou vendedor. Selecione um cargo próprio da equipe.');
    let role = guild.roles.cache.get(id);
    if (!role) {
      try { role = await guild.roles.fetch(id); }
      catch (error) { if (error.code !== 10011 && error.status !== 404) throw error; }
    }
    if (!role) throw new Error('O cargo de equipe selecionado não existe neste servidor.');
    if (role.managed) throw new Error('Cargos gerenciados por bots ou integrações não podem ser usados como administrador ou vendedor. Selecione um cargo próprio da equipe.');
  }
}

function normalizeOverwrite(overwrite) {
  const type = overwrite.type === 'Role' ? OverwriteType.Role : overwrite.type === 'Member' ? OverwriteType.Member : overwrite.type;
  if (type !== OverwriteType.Role && type !== OverwriteType.Member) throw new Error('Uma permissão existente não informa se pertence a cargo ou membro. Confira a configuração do canal antes de alterá-la.');
  return { id: String(overwrite.id), type, allow: PermissionsBitField.resolve(overwrite.allow ?? 0n), deny: PermissionsBitField.resolve(overwrite.deny ?? 0n) };
}

function dataChannelProtected(channel, guild, client, { adminRoleId, sellerRoleId } = {}) {
  if (!channel.permissionOverwrites.cache) return false;
  const existing = new Map([...channel.permissionOverwrites.cache.values()].map(item => { const plain = normalizeOverwrite(item); return [plain.id, plain]; }));
  const everyone = existing.get(guild.roles.everyone.id);
  const bot = existing.get(client?.user?.id || guild.members?.me?.id);
  if (!everyone || everyone.type !== OverwriteType.Role || !(everyone.deny & P.ViewChannel) || (everyone.allow & P.ViewChannel)) return false;
  if (!bot || bot.type !== OverwriteType.Member || DATA_PERMISSIONS.some(permission => !(bot.allow & permission) || (bot.deny & permission))) return false;
  if (adminRoleId) {
    const admin = existing.get(adminRoleId);
    if (!admin || admin.type !== OverwriteType.Role || !(admin.allow & P.ViewChannel) || !(admin.allow & P.ReadMessageHistory)) return false;
  }
  if (sellerRoleId && sellerRoleId !== adminRoleId && ((existing.get(sellerRoleId)?.allow || 0n) & P.ViewChannel)) return false;
  return true;
}

/** Read the entire history, using a cursor rather than a fixed page ceiling. */
async function fetchAllMessages(channel) {
  if (!channel?.messages?.fetch) return [];
  const messages = [];
  const seen = new Set();
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch?.size) break;
    const values = [...batch.values()];
    for (const message of values) {
      if (!seen.has(message.id)) { seen.add(message.id); messages.push(message); }
    }
    const next = values[values.length - 1]?.id;
    if (values.length < 100) break;
    if (!next || next === before) throw new Error('A paginação do histórico não avançou.');
    before = next;
  }
  return messages;
}

function splitText(value, limit = 1900) {
  if (!Number.isInteger(limit) || limit < 20) throw new Error('Limite de página inválido.');
  const text = String(value ?? '');
  if (!text) return ['Nenhum registro encontrado.'];
  const pages = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    // Discord measures UTF-16 units; do not split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1] || '')) end--;
    pages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }
  if (remaining) pages.push(remaining);
  return pages;
}

function safe(value) {
  return String(value ?? '-').replace(/([\\`*_~|>])/g, '\\$1');
}
function dateBR(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
  }).format(date);
}
function money(cents) {
  return Number.isFinite(cents) ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'não informado';
}

/** Explicit display fields for private records; credentials come from getDisplayRecord. */
function renderRecord(record) {
  if (!record) return 'Registro indisponível.';
  const labels = { vendas: 'VENDA', vencimentos: 'VENCIMENTO', renovacoes: 'RENOVAÇÃO', trocas: 'TROCA' };
  const lines = [
    `**${labels[record.type] || 'REGISTRO'} ${safe(record.id)}**`,
    `Cliente: ${safe(record.client)}`, `Ferramenta: ${safe(record.tool)}`
  ];
  if (record.saleId) lines.push(`Venda: ${safe(record.saleId)}`);
  if (record.accountId) lines.push(`Conta: ${safe(record.accountId)}`);
  if (record.login) lines.push(`Login: ${safe(record.login)}`);
  if (record.type === 'vendas' || (record.type === 'trocas' && record.newPlan)) lines.push(`Senha: ${record.password !== undefined ? safe(record.password) : 'não disponível no histórico'}`);
  if (record.previousPlan) lines.push(`Plano anterior: ${safe(record.previousPlan)}`);
  if (record.newPlan) lines.push(`Plano novo: ${safe(record.newPlan)}`);
  if (record.plan) lines.push(`Plano original: ${safe(record.plan)}`);
  if (record.currentPlan && record.currentPlan !== record.plan) lines.push(`Plano atual: ${safe(record.currentPlan)}`);
  if (record.priceUnknown) lines.push('Valor cobrado: desconhecido no histórico migrado');
  else if (record.priceCents != null) lines.push(`Valor cobrado: ${money(record.priceCents)}${record.priceEstimated ? ' (estimado na migração)' : ''}`);
  if (record.discountCents) lines.push(`Desconto: ${money(record.discountCents)}`);
  if (record.registeredAt) lines.push(`Registrado: ${dateBR(record.registeredAt)}`);
  if (record.expiresAt) lines.push(`Vencimento: ${dateBR(record.expiresAt)}`);
  if (record.status) lines.push(`Estado: ${safe(record.status)}`);
  if (record.reason) lines.push(`Motivo: ${safe(record.reason)}`);
  if (record.observation) lines.push(`Observação: ${safe(record.observation)}`);
  if (record.actorId) lines.push(`Responsável: ${safe(record.actorId)}`);
  if (record.migrationConflict) lines.push('⚠️ Conta em conflito no histórico: revisão necessária.');
  return recordBlock(lines.join('\n'));
}

async function showPages(interaction, content, { files = [], timeout = 120000 } = {}) {
  const pages = (Array.isArray(content) ? content : splitText(content)).flatMap(page => splitText(page));
  const token = crypto.randomBytes(8).toString('hex');
  let page = 0;
  const components = disabled => pages.length < 2 ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`uf4:${token}:prev`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
    new ButtonBuilder().setCustomId(`uf4:${token}:next`).setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === pages.length - 1)
  )];
  const payload = () => ({ content: `${pages[page]}${pages.length > 1 ? `\n\nPágina ${page + 1}/${pages.length}` : ''}`, components: components(false), allowedMentions: NO_MENTIONS });
  if (interaction.deferred || interaction.replied) await interaction.editReply({ ...payload(), files });
  else await interaction.reply({ ...payload(), files, flags: MessageFlags.Ephemeral });
  if (pages.length < 2) return;
  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({ time: timeout, filter: event => event.customId.startsWith(`uf4:${token}:`) });
  collector.on('collect', async event => {
    try {
      if (event.user.id !== interaction.user.id) {
        await event.reply({ content: 'Estas páginas pertencem a outra consulta.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        return;
      }
      page = Math.max(0, Math.min(pages.length - 1, page + (event.customId.endsWith(':next') ? 1 : -1)));
      await event.update(payload());
    } catch (error) { collector.stop('interaction-unavailable'); }
  });
  collector.on('end', async () => {
    try { await interaction.editReply({ components: components(true) }); } catch { /* Expired interaction. */ }
  });
}

function permissions(guild, client, { adminRoleId, sellerRoleId } = {}, adminOnly = false, readOnly = false) {
  const view = [P.ViewChannel, P.ReadMessageHistory];
  const write = [P.SendMessages, P.AttachFiles, P.EmbedLinks];
  const botId = client?.user?.id || guild.members?.me?.id;
  if (!botId) throw new Error('O bot ainda não está conectado ao Discord.');
  const deny = [P.ViewChannel, ...(readOnly ? write : [])];
  const result = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny },
    { id: botId, type: OverwriteType.Member, allow: [...view, ...write, P.ManageChannels, P.ManageRoles] }
  ];
  const roleIds = new Set([adminRoleId, ...(!adminOnly ? [sellerRoleId] : [])].filter(Boolean));
  for (const id of roleIds) result.push({ id, type: OverwriteType.Role, allow: [...view, ...(!readOnly ? write : [])], ...(readOnly ? { deny: write } : {}) });
  return result;
}

async function channelById(guild, id) {
  if (!id) return null;
  const cached = guild.channels.cache.get(id);
  if (cached) return cached;
  try { return await guild.channels.fetch(id); }
  catch (error) { if (error.code === 10003 || error.status === 404) return null; throw error; }
}

/** Bootstrap channel before the encrypted Discord Store can be loaded. */
async function ensureDataChannel(guild, options = {}) {
  await guild.channels.fetch();
  await validateStaffRoles(guild, options);
  let overwrites = permissions(guild, options.client, options, true, true);
  let channel = await channelById(guild, options.channelId);
  if (options.channelId && !channel) throw new Error('DISCORD_DATA_CHANNEL_ID não existe neste servidor; preserve o canal e selecione o ID correto.');
  if (!channel) {
    const textChannels = [...guild.channels.cache.values()].filter(item => item.type === ChannelType.GuildText);
    const marked = textChannels.filter(item => item.topic?.startsWith('UF4: armazenamento criptografado'));
    const matches = marked.length ? marked : textChannels.filter(item => item.name === CHANNEL_NAMES.dados);
    if (matches.length > 1) throw new Error('Há mais de um canal dados-bot. Informe DISCORD_DATA_CHANNEL_ID para selecionar o histórico correto.');
    channel = matches[0];
  }
  if (channel && (channel.type !== ChannelType.GuildText || (channel.guildId && channel.guildId !== guild.id))) throw new Error('O canal de dados precisa ser um canal de texto deste servidor.');
  if (options.channelId && channel.name !== CHANNEL_NAMES.dados && !channel.topic?.startsWith('UF4: armazenamento criptografado')) throw new Error('DISCORD_DATA_CHANNEL_ID não identifica o canal de dados do bot. Verifique o ID antes de alterar permissões.');
  if (channel && dataChannelProtected(channel, guild, options.client, options)) {
    await validateSetupPermissions(guild, { channels: [channel], manage: false });
    return channel;
  }
  await validateSetupPermissions(guild, { channels: channel ? [channel] : [] });
  if (!channel) channel = await guild.channels.create({ name: CHANNEL_NAMES.dados, type: ChannelType.GuildText, permissionOverwrites: overwrites, topic: 'UF4: armazenamento criptografado do bot; não apague mensagens.' });
  else {
    // Before loading the Store we do not yet know the persisted admin role.
    // Preserve its grants and only repair everyone/bot, then setup reapplies config.
    if (!options.adminRoleId && channel.permissionOverwrites.cache) {
      const replaced = new Set(overwrites.map(item => item.id));
      overwrites = [...overwrites, ...[...channel.permissionOverwrites.cache.values()].filter(item => !replaced.has(item.id)).map(normalizeOverwrite)];
    }
    await channel.permissionOverwrites.set(overwrites, 'Proteção do armazenamento do bot');
    if (!channel.topic?.startsWith('UF4: armazenamento criptografado') && channel.setTopic) await channel.setTopic('UF4: armazenamento criptografado do bot; não apague mensagens.');
  }
  return channel;
}

class DiscordTransport {
  constructor({ client, store, catalog, clock = () => new Date() }) {
    this.client = client;
    this.store = store;
    this.catalog = catalog?.TOOLS || catalog || {};
    this.clock = clock;
    this.flushing = new Map();
  }

  async getChannel(guild, key) {
    const channels = await this.store.getConfig(guild.id, 'channels', {});
    return channelById(guild, channels[key]);
  }

  async setup(guild, { adminRoleId, sellerRoleId, actorId } = {}) {
    const savedRoles = await this.store.getConfig(guild.id, 'roles', {});
    const roles = { adminRoleId: adminRoleId || savedRoles.adminRoleId || null, sellerRoleId: sellerRoleId || savedRoles.sellerRoleId || null };
    await validateStaffRoles(guild, roles);
    const channels = await this.store.getConfig(guild.id, 'channels', {});
    const categories = await this.store.getConfig(guild.id, 'categories', {});
    const targets = [this.store.channel];
    for (const id of new Set([...Object.values(channels), ...Object.values(categories)])) targets.push(await channelById(guild, id));
    await validateSetupPermissions(guild, { channels: [...new Map(targets.filter(Boolean).map(channel => [channel.id, channel])).values()] });
    const groupSpecs = [
      ['staff', '🔒 UNLOCK FÁCIL', false], ['accounts', '📁 CONTAS LIVRES', false], ['admin', '🤖 ADMINISTRAÇÃO', true]
    ];
    for (const [key, name, adminOnly] of groupSpecs) {
      let category = await channelById(guild, categories[key]);
      const overwrites = permissions(guild, this.client, roles, adminOnly, true);
      if (!category || category.type !== ChannelType.GuildCategory) category = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
      else await category.permissionOverwrites.set(overwrites, 'Atualização dos cargos autorizados');
      categories[key] = category.id;
      await this.store.setConfig(guild.id, 'categories', { ...categories }, { actorId });
    }
    const names = { ...CHANNEL_NAMES };
    for (const tool of Object.values(this.catalog)) names[tool.channelKey] = tool.channelName;
    const toolKeys = new Set(Object.values(this.catalog).map(tool => tool.channelKey));
    for (const [key, name] of Object.entries(names)) {
      const adminOnly = ADMIN_CHANNELS.has(key);
      const parent = categories[adminOnly ? 'admin' : toolKeys.has(key) ? 'accounts' : 'staff'];
      const overwrites = permissions(guild, this.client, roles, adminOnly, key !== 'painel');
      let channel = key === 'dados' ? this.store.channel : await channelById(guild, channels[key]);
      if (!channel || channel.type !== ChannelType.GuildText) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites });
      else {
        if (channel.parentId !== parent) await channel.setParent(parent, { lockPermissions: false });
        await channel.permissionOverwrites.set(overwrites, 'Atualização dos cargos autorizados');
      }
      channels[key] = channel.id;
      if (key === 'dados' && !channel.topic?.startsWith('UF4: armazenamento criptografado') && channel.setTopic) await channel.setTopic('UF4: armazenamento criptografado do bot; não apague mensagens.');
      // Persist each creation, so a interrupted setup can repair its own channels.
      await this.store.setConfig(guild.id, 'channels', { ...channels }, { actorId });
    }
    await this.store.setConfig(guild.id, 'roles', roles, { actorId });
    await this.setupCommands(guild);
    return { channels, categories, roles };
  }

  async publishPanel(guild, content) {
    const channel = await this.getChannel(guild, 'painel');
    if (!channel?.send) return;
    const chunks = splitText(String(content), 1700);
    const messages = await fetchAllMessages(channel);
    const existing = messages.filter(message => message.author?.id === this.client.user.id && /UF4:PANEL:\d+/.test(message.content || ''));
    for (let index = 0; index < chunks.length; index++) {
      const body = `${chunks[index]}\nUF4:PANEL:${index}`;
      const old = existing.find(message => message.content.includes(`UF4:PANEL:${index}`));
      if (old) {
        if (old.content !== body) await old.edit({ content: body, allowedMentions: NO_MENTIONS });
      } else {
        await channel.send({ content: body, allowedMentions: NO_MENTIONS });
      }
    }
    for (const message of existing) {
      const match = /UF4:PANEL:(\d+)/.exec(message.content || '');
      if (match && Number(match[1]) >= chunks.length) await message.delete().catch(() => {});
    }
  }

  async publishAdExpenses(guild, content) {
    const channel = await this.getChannel(guild, 'anuncios');
    if (!channel?.send) return;
    const chunks = splitText(String(content), 1700);
    const messages = await fetchAllMessages(channel);
    const existing = messages.filter(message => message.author?.id === this.client.user.id && /UF4:ADSPEND:\d+/.test(message.content || ''));
    for (let index = 0; index < chunks.length; index++) {
      const body = `${chunks[index]}\nUF4:ADSPEND:${index}`;
      const old = existing.find(message => message.content.includes(`UF4:ADSPEND:${index}`));
      if (old) {
        if (old.content !== body) await old.edit({ content: body, allowedMentions: NO_MENTIONS });
      } else await channel.send({ content: body, allowedMentions: NO_MENTIONS });
    }
    for (const message of existing) {
      const match = /UF4:ADSPEND:(\d+)/.exec(message.content || '');
      if (match && Number(match[1]) >= chunks.length) await message.delete().catch(() => {});
    }
  }

  async setupCommands(guild) {
    const channel = await this.getChannel(guild, 'comandos');
    if (!channel) return;
    const content = [
      '**UNLOCK FÁCIL — COMANDOS**',
      'Use o canal de painel. Consultas e credenciais exibidas por comando são privadas.',
      '`/conta` cadastra uma conta no estoque; `/estoque` consulta contas por ferramenta e estado.',
      '`/vender` reserva uma conta livre, registra o valor cobrado e calcula o vencimento.',
      '`/renovar venda:VEN-...` registra uma nova receita e mantém os valores anteriores.',
      '`/editar-venda venda:VEN-...` corrige os campos informados, mantendo o ID.',
      '`/troca venda:VEN-... plano_anterior:... plano_novo:... login:... senha:...` substitui a conta da venda.',
      '`/vencidas` mostra as contas que aguardam troca externa; `/vencimentos-proximos` consulta próximas datas.',
      '`/troca-senha` e `/trocar-senhas` registram a senha nova SOMENTE após confirmar que a troca foi realizada na ferramenta externa.',
      'O bot não altera senhas nas ferramentas externas. A conta só volta ao estoque após a confirmação e a publicação das credenciais.',
      '`/ver`, `/buscar`, `/listar` e `/exportar` consultam o histórico e os valores registrados. O painel atualiza automaticamente no canal próprio.',
      '`/excluir` é exclusivo da administração, exige confirmação e registra a ação na auditoria. Contas ocupadas e vendas com registros relacionados são protegidas.',
      '`/alertas` configura avisos de vencimento; `/auditoria` mostra responsáveis e alterações.',
      '`/configurar`, `/migrar` e `/backup` são restritos à administração.',
      'As vendas exibem a senha no canal privado e nas consultas autorizadas. Exportações e auditoria não incluem senhas. O armazenamento e os backups preservam a criptografia.',
      'UF4:HELP'
    ].join('\n');
    const existing = (await fetchAllMessages(channel)).find(message => message.author?.id === this.client.user.id && message.content?.includes('UF4:HELP'));
    if (existing) await existing.edit({ content, allowedMentions: NO_MENTIONS });
    else await channel.send({ content, allowedMentions: NO_MENTIONS });
  }

  async archiveLegacy(guild, channel) {
    const roles = await this.store.getConfig(guild.id, 'roles', {});
    await validateStaffRoles(guild, roles);
    await validateSetupPermissions(guild, { channels: [channel] });
    await channel.permissionOverwrites.set(permissions(guild, this.client, roles, false, true), 'Histórico migrado: acesso restrito e leitura para a equipe');
    if (channel.type === ChannelType.GuildText && !channel.name.startsWith('arquivo-')) await channel.setName(`arquivo-${channel.name}`.slice(0, 100));
  }

  async findDelivery(channel, marker, cache) {
    if (!cache.has(channel.id)) cache.set(channel.id, await fetchAllMessages(channel));
    return cache.get(channel.id).find(message => message.author?.id === this.client.user.id && message.content?.split('\n').includes(marker));
  }

  async publish(channel, item, content, { messageId, files = [], cache, page = 0, clearFiles = false } = {}) {
    const marker = `UF4:${item.kind}:${item.id}${page ? `:${page}` : ''}`;
    const body = content.endsWith(`\n${RECORD_SEPARATOR}`)
      ? `${content.slice(0, -(RECORD_SEPARATOR.length + 1))}\n${marker}\n${RECORD_SEPARATOR}`
      : recordBlock(`${content}\n${marker}`);
    if (body.length > 2000) throw new Error('Publicação excede o limite do Discord.');
    let existing;
    if (messageId) {
      try { existing = await channel.messages.fetch(messageId); }
      catch (error) { if (error.code !== 10008 && error.status !== 404) throw error; }
      if (existing && existing.author?.id !== this.client.user.id) throw new Error('O registro mapeado não pertence ao bot.');
    }
    if (!existing) existing = await this.findDelivery(channel, marker, cache);
    const payload = { content: body, allowedMentions: NO_MENTIONS, ...(files.length ? { files } : {}), ...(clearFiles ? { attachments: [] } : {}) };
    if (existing) return existing.edit(payload);
    const nonce = crypto.createHash('sha256').update(`${item.id}:${page}`).digest('hex').slice(0, 24);
    const sent = await channel.send({ ...payload, nonce, enforceNonce: true });
    if (cache.has(channel.id)) cache.get(channel.id).push(sent);
    return sent;
  }

  async flush(guild) {
    if (this.flushing.has(guild.id)) return this.flushing.get(guild.id);
    const running = this.flushOnce(guild).finally(() => this.flushing.delete(guild.id));
    this.flushing.set(guild.id, running);
    return running;
  }

  async flushOnce(guild) {
    const result = { delivered: 0, skipped: 0, errors: [] };
    const cache = new Map();
    for (const item of await this.store.listOutbox(guild.id)) {
      try {
        let skipped = false;
        const transaction = this.store.transaction ? this.store.transaction.bind(this.store) : async callback => callback();
        // Keep account reservation and publication serialized in this runtime.
        // A sale cannot reserve the account between the read and credential send.
        await transaction(async () => {
        let channel, published;
        if (item.kind === 'record') {
          const record = await (this.store.getDisplayRecord || this.store.getRecord).call(this.store, guild.id, item.payload.type, item.payload.id);
          if (!record) throw new Error('Registro da publicação não encontrado.');
          channel = await this.getChannel(guild, record.type);
          if (!channel) throw new Error('Canal de registros não configurado.');
          const pages = recordPages(record);
          for (let page = 0; page < pages.length; page++) {
            const message = await this.publish(channel, item, pages[page], { messageId: page === 0 ? record.messageId : undefined, page, cache });
            if (page === 0) published = message;
          }
        } else if (item.kind === 'account' || item.kind === 'free-account') {
          const account = await this.store.getAccount(guild.id, item.payload.accountId);
          if (!account) throw new Error('Conta da publicação não encontrada.');
          if (item.kind === 'free-account' && (account.status !== 'available' || account.activeSaleId || (account.pendingExpirationId && account.pendingExpirationId !== item.payload.expirationId))) {
            await this.store.completeOutbox(item.id, { skipped: true }); skipped = true; return;
          }
          const spec = this.catalog[account.tool];
          channel = spec && await this.getChannel(guild, spec.channelKey);
          if (!channel) throw new Error('Canal da ferramenta não configurado.');
          const available = account.status === 'available' && !account.activeSaleId;
          const content = [`**CONTA ${safe(account.id)} — ${available ? 'DISPONÍVEL' : 'OCUPADA'}**`, `Ferramenta: ${safe(account.tool)}`, `Login: ${safe(account.login)}`, available ? 'Credenciais confirmadas no arquivo privado abaixo.' : `Venda atual: ${safe(account.activeSaleId)}`].join('\n');
          const files = available ? [{ attachment: Buffer.from(JSON.stringify({ accountId: account.id, tool: account.tool, login: account.login, password: account.password }, null, 2)), name: `credenciais-${account.id}.json` }] : [];
          published = await this.publish(channel, item, content, { messageId: account.freeMessageId, files, clearFiles: true, cache });
        } else if (item.kind === 'reminder') {
          const sale = await this.store.getRecord(guild.id, 'vendas', item.payload.saleId);
          const account = sale?.accountId ? await this.store.getAccount(guild.id, sale.accountId) : null;
          const now = +new Date(this.clock());
          if (!sale || sale.status !== 'active' || sale.expiresAt !== item.payload.expiresAt || +new Date(sale.expiresAt) <= now || !account || account.activeSaleId !== sale.id) {
            await this.store.completeOutbox(item.id, { skipped: true }); skipped = true; return;
          }
          channel = await this.getChannel(guild, 'alertas');
          if (!channel) throw new Error('Canal de alertas não configurado.');
          published = await this.publish(channel, item, `🔔 **Vencimento próximo ${safe(sale.id)}**\nCliente: ${safe(sale.client)}\nFerramenta: ${safe(sale.tool)}\nVence em: ${dateBR(sale.expiresAt)}\nUse /renovar com o ID da venda.`, { cache });
        } else {
          throw new Error(`Tipo de publicação desconhecido: ${item.kind}`);
        }
        await this.store.completeOutbox(item.id, { messageId: published.id, channelId: channel.id });
        });
        if (skipped) result.skipped++;
        else result.delivered++;
      } catch (error) {
        await this.store.failOutbox(item.id, error);
        result.errors.push({ id: item.id, error: error.message });
      }
    }
    return result;
  }

  async reminders(guild) {
    const config = await this.store.getConfig(guild.id, 'alerts', { enabled: true });
    if (config.enabled === false) return 0;
    const sales = await this.store.listRecords(guild.id, 'vendas');
    const now = +new Date(this.clock());
    let queued = 0;
    for (const sale of sales) {
      if (sale.status !== 'active') continue;
      const remaining = +new Date(sale.expiresAt) - now;
      const defaultLead = (sale.currentPlan || sale.plan) === '12 horas' ? 60 : 24 * 60;
      const leadMinutes = Number(config.leadMinutes ?? config.byPlan?.[sale.currentPlan || sale.plan] ?? defaultLead);
      if (!Number.isFinite(leadMinutes) || leadMinutes <= 0 || remaining <= 0 || remaining > leadMinutes * 60000) continue;
      const account = await this.store.getAccount(guild.id, sale.accountId);
      if (!account || account.activeSaleId !== sale.id) continue;
      await this.store.queueOutbox(guild.id, 'reminder', { saleId: sale.id, expiresAt: sale.expiresAt, leadMinutes }, `reminder:${sale.id}:${sale.expiresAt}:${leadMinutes}`);
      queued++;
    }
    return queued;
  }

  async backup(guild) {
    const channel = await this.getChannel(guild, 'backups');
    if (!channel) throw new Error('Canal privado de backups não configurado.');
    const attachment = await this.store.exportSnapshot();
    const envelope = JSON.parse(attachment.toString('utf8'));
    // Never send an accidentally plaintext snapshot into the Discord backup channel.
    if (envelope.state || (!envelope.encrypted && !envelope.payloadEncrypted && !envelope.ciphertext && !envelope.payload?.ciphertext)) throw new Error('O snapshot deve estar criptografado antes da publicação.');
    return channel.send({ content: `Backup criptografado — ${dateBR(this.clock())}. Guarde a chave de criptografia separadamente.`, files: [{ attachment, name: `unlock-backup-${guild.id}.json` }], allowedMentions: NO_MENTIONS });
  }
}

module.exports = { DiscordTransport, ensureDataChannel, fetchAllMessages, splitText, renderRecord, recordBlock, recordPages, RECORD_SEPARATOR, showPages, CHANNEL_NAMES, validateSetupPermissions, validateStaffRoles, normalizeOverwrite };

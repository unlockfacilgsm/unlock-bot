'use strict';

const { PermissionFlagsBits, MessageFlags, escapeMarkdown } = require('discord.js');
const catalog = require('./catalog');
const { formatBR, buildRegisteredAt, parseDateOnlyBR } = require('./dates');
const validation = require('./validation');
const { dashboardText, exportCsv } = require('./reporting');
const { ADMIN_COMMANDS, MUTATING_COMMANDS } = require('./commands');
const { renderRecord, recordBlock, showPages } = require('./transport');
const { formatDiscordError, safeErrorDetails } = require('./discord-errors');

const TYPES = ['vendas', 'vencimentos', 'trocas', 'renovacoes'];
const safe = value => escapeMarkdown(String(value ?? '-'));

function option(interaction, type, name) {
  return interaction.options[`get${type}`]?.(name) ?? null;
}

function hasRole(member, id) {
  if (!id) return false;
  return Array.isArray(member?.roles) ? member.roles.includes(id) : Boolean(member?.roles?.cache?.has(id));
}

class BotApp {
  constructor({ client, store, transport, migrate, guildId, clock = () => new Date(), adminRoleId, sellerRoleId, logger = console }) {
    Object.assign(this, { client, store, transport, migrate, guildId, clock, adminRoleId, sellerRoleId, logger });
    this.runningTick = null;
    this.stopping = false;
    this.requiresMigration = false;
  }

  async authorization(interaction) {
    if (!interaction.guild || interaction.guild.id !== this.guildId) return { admin: false, seller: false };
    const roles = await this.store.getConfig(this.guildId, 'roles', { adminRoleId: this.adminRoleId, sellerRoleId: this.sellerRoleId });
    const admin = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) || hasRole(interaction.member, roles.adminRoleId);
    return { admin, seller: admin || hasRole(interaction.member, roles.sellerRoleId) };
  }

  async handle(interaction) {
    const autocomplete = interaction.isAutocomplete?.();
    if (!autocomplete && !interaction.isChatInputCommand?.()) return;
    try {
      const access = await this.authorization(interaction);
      if (autocomplete) {
        if (!access.seller) return interaction.respond([]);
        return this.autocomplete(interaction);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const command = interaction.commandName;
      if (!access.seller || (ADMIN_COMMANDS.has(command) && !access.admin)) throw new Error('Seu cargo não está autorizado a executar este comando.');
      if (this.stopping) throw new Error('O bot está reiniciando. Tente novamente em alguns instantes.');
      const channels = await this.store.getConfig(this.guildId, 'channels', {});
      const setupCommands = ['configurar', 'migrar', 'restaurar', 'backup'];
      if (!setupCommands.includes(command) && (!channels.painel || interaction.channelId !== channels.painel)) {
        throw new Error('Execute este comando no canal de painel configurado pelo bot.');
      }
      const readingAccounts = command === 'conta' && interaction.options.getSubcommand() === 'listar';
      if (MUTATING_COMMANDS.has(command) && !readingAccounts && !['configurar', 'migrar', 'restaurar', 'alertas'].includes(command) && (this.requiresMigration || await this.store.getConfig(this.guildId, 'migrationRequired', false))) {
        throw new Error('Importe o histórico com /migrar antes de registrar novas operações.');
      }
      await this.execute(interaction);
    } catch (error) {
      this.logger.error(`[${interaction.commandName}] ${safeErrorDetails(error)}`);
      if (autocomplete) {
        if (!interaction.responded) await interaction.respond([]).catch(() => {});
        return;
      }
      const message = formatDiscordError(error);
      const reply = { content: `❌ ${safe(message).slice(0, 1800)}`, allowedMentions: { parse: [] } };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(reply);
        else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
      } catch (replyError) { this.logger.error(`Falha ao responder à interação: ${safeErrorDetails(replyError)}`); }
    }
  }

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'plano') return interaction.respond([]);
    let tool = option(interaction, 'String', 'ferramenta');
    if (interaction.commandName === 'renovar') {
      const saleId = option(interaction, 'String', 'venda');
      const sale = saleId ? await this.store.getRecord(this.guildId, 'vendas', saleId.trim().toUpperCase()) : null;
      tool = sale?.tool;
    }
    return interaction.respond(catalog.planChoices(tool, focused.value));
  }

  async publishChanges(interaction, content) {
    try {
      const result = await this.transport.flush(interaction.guild);
      if ((Array.isArray(result?.errors) && result.errors.length) || (await this.store.listOutbox(this.guildId)).length) content += '\n⏳ Algumas publicações estão pendentes e serão retomadas automaticamente.';
    } catch (error) {
      this.logger.error(`[${interaction.commandName}] Publicação pendente: ${safeErrorDetails(error)}`);
      content += '\n⏳ Publicação pendente. A operação foi registrada e será retomada automaticamente.';
    }
    return showPages(interaction, content);
  }

  async records(type, query) {
    if (type === 'contas') return (await this.store.listAccounts(this.guildId, { query })).map(account => ({ ...account, type: 'contas' }));
    if (type && type !== 'tudo') {
      if (!TYPES.includes(type)) throw new Error('Tipo de registro inválido.');
      return this.store.listRecords(this.guildId, type, { query });
    }
    const groups = await Promise.all(TYPES.map(current => this.store.listRecords(this.guildId, current, { query })));
    const accounts = (await this.store.listAccounts(this.guildId, { query })).map(account => ({ ...account, type: 'contas' }));
    return [...groups.flat(), ...accounts].sort((a, b) => (b.registeredAt || '').localeCompare(a.registeredAt || ''));
  }

  async accountText(account) {
    const sale = account.activeSaleId ? await this.store.getRecord(this.guildId, 'vendas', account.activeSaleId) : null;
    const status = account.pendingDelivery ? 'Aguardando publicação' : account.status === 'available' ? 'Disponível' : sale?.status === 'expired' ? 'Aguardando troca de senha' : 'Em uso';
    return recordBlock(`${safe(account.id)} — ${safe(account.tool)}\nLogin: ${safe(account.login)}\nSituação: ${status}${sale ? `\nVenda: ${safe(sale.id)} — ${formatBR(sale.expiresAt)}` : ''}`);
  }

  async displayRecord(record, type = record.type) {
    if (type === 'contas') return this.accountText(record);
    const display = await this.store.getDisplayRecord(this.guildId, type, record.id);
    return renderRecord(display || record);
  }

  async execute(interaction) {
    const command = interaction.commandName;
    const guildId = this.guildId;
    const actorId = interaction.user.id;
    const now = this.clock();
    const registeredAt = now.toISOString();
    const str = name => option(interaction, 'String', name);
    const number = name => option(interaction, 'Number', name);

    if (command === 'configurar') {
      const old = await this.store.getConfig(guildId, 'roles', {});
      const adminRole = option(interaction, 'Role', 'administrador');
      const sellerRole = option(interaction, 'Role', 'vendedor');
      const adminRoleId = adminRole?.id || old.adminRoleId || this.adminRoleId;
      const sellerRoleId = sellerRole?.id || old.sellerRoleId || this.sellerRoleId;
      const roleError = message => Object.assign(new Error(message), { code: 'BOT_INVALID_ROLE' });
      for (const [field, id, chosen] of [['administrador', adminRoleId, adminRole], ['vendedor', sellerRoleId, sellerRole]]) {
        if (!id) continue;
        const example = field === 'administrador' ? 'Administração' : 'Vendedores';
        if (id === guildId) {
          throw roleError(`Não use @everyone em ${field}: esse cargo inclui todo o servidor. Crie um cargo ${example} em Configurações do servidor → Cargos, atribua às pessoas da equipe e selecione esse cargo. O campo aceita cargos, não seu @ de usuário.`);
        }
        let resolved = interaction.guild.roles?.cache?.get(id);
        if (!resolved && interaction.guild.roles?.fetch) resolved = await interaction.guild.roles.fetch(id);
        if (chosen?.managed || resolved?.managed) {
          throw roleError(`O cargo ${chosen?.name || resolved?.name || id} é gerenciado por uma integração ou bot. Em ${field}, escolha um cargo da equipe, como ${example}. O bot já recebe acesso pela própria conta e não precisa ser administrador ou vendedor da equipe.`);
        }
      }
      const configured = await this.transport.setup(interaction.guild, { adminRoleId, sellerRoleId, actorId });
      if (this.requiresMigration) await this.store.setConfig(guildId, 'migrationRequired', true, { actorId });
      const channels = configured?.channels || await this.store.getConfig(guildId, 'channels', {});
      return showPages(interaction, [
        '✅ Estrutura privada configurada. Os canais e registros antigos foram preservados.',
        `Administrador: ${adminRoleId ? `<@&${adminRoleId}>` : 'pessoas com Gerenciar servidor; nenhum cargo adicional definido'}.`,
        `Vendedor: ${sellerRoleId ? `<@&${sellerRoleId}>` : 'nenhum cargo definido; selecione um cargo Vendedores quando houver equipe'}.`,
        'Os campos administrador e vendedor são cargos de pessoas. O bot usa o próprio acesso e seu cargo de integração.',
        channels.painel ? `Use os comandos de operação em <#${channels.painel}>.` : 'Use os comandos de operação no canal de painel criado.'
      ].join('\n'));
    }

    if (command === 'migrar') {
      const result = await this.migrate(interaction.guild, { client: this.client, store: this.store, transport: this.transport, catalog, clock: this.clock });
      if (!result.errors?.length) {
        await this.store.setConfig(guildId, 'migrationRequired', false, { actorId });
        await this.store.setConfig(guildId, 'migrationCompleted', true, { actorId });
        this.requiresMigration = false;
      }
      return this.publishChanges(interaction, `📥 Resultado da migração:\n${safe(JSON.stringify(result, null, 2))}\nValores históricos sem preço registrado ficam sinalizados como estimados.`);
    }

    if (command === 'backup') {
      const message = await this.transport.backup(interaction.guild);
      return showPages(interaction, `✅ Backup enviado ao canal privado.${message?.url ? `\n${message.url}` : ''}\nGuarde também sua chave ENCRYPTION_KEY em um lugar seguro.`);
    }

    if (command === 'restaurar') {
      if (option(interaction, 'Boolean', 'confirmada') !== true) throw new Error('Confirme a restauração antes de continuar.');
      const file = option(interaction, 'Attachment', 'arquivo');
      if (!file || file.size > 20 * 1024 * 1024) throw new Error('Anexe um backup válido de até 20 MB.');
      const url = new URL(file.url);
      if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('O backup deve ser um anexo do Discord.');
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Não foi possível baixar o backup.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error('O backup supera o tamanho permitido.');
      await this.store.restoreSnapshot(bytes);
      this.requiresMigration = false;
      return showPages(interaction, '✅ Backup restaurado. Execute /configurar para verificar os canais e retomar as publicações.');
    }

    if (command === 'conta') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'adicionar') {
        const tool = str('ferramenta');
        if (!Object.hasOwn(catalog.TOOLS, tool)) throw new Error('Ferramenta inválida.');
        const account = await this.store.upsertAccount(guildId, { tool, login: validation.text(str('login'), 'Login'), password: validation.password(str('senha')), actorId });
        return this.publishChanges(interaction, `✅ Conta **${safe(account.id)}** adicionada ao estoque de ${safe(tool)}.`);
      }
      if (subcommand === 'senha') {
        validation.confirmed(option(interaction, 'Boolean', 'confirmada'));
        const account = await this.store.updateAccountPassword(guildId, { accountId: validation.id(str('conta'), 'ACC'), newPassword: validation.password(str('nova_senha')), actorId });
        return this.publishChanges(interaction, `✅ Troca externa registrada para **${safe(account.id)}**. A situação da conta foi mantida.`);
      }
      let accounts = await this.store.listAccounts(guildId, { tool: str('ferramenta') || undefined });
      const status = str('status');
      if (status) {
        const sales = await this.store.listRecords(guildId, 'vendas');
        const expired = new Set(sales.filter(sale => sale.status === 'expired').map(sale => sale.id));
        accounts = accounts.filter(account => status === 'disponivel' ? account.status === 'available' && !account.pendingDelivery : status === 'aguardando-senha' ? expired.has(account.activeSaleId) : account.status === 'occupied' && !expired.has(account.activeSaleId));
      }
      return showPages(interaction, accounts.length ? await Promise.all(accounts.map(account => this.accountText(account))) : 'Nenhuma conta encontrada.');
    }

    if (command === 'vender') {
      const tool = str('ferramenta'), plan = str('plano');
      const accountId = str('conta');
      const login = str('login'), password = str('senha');
      if (accountId && (login != null || password != null)) throw new Error('Escolha a conta pelo ID ou informe login e senha manualmente.');
      if (!accountId && (!login || password == null)) throw new Error('Informe uma conta disponível ou preencha login e senha.');
      const values = validation.amounts(tool, plan, number('valor'), number('desconto'));
      const sale = await this.store.createSale(guildId, { client: validation.text(str('cliente'), 'Cliente'), tool, plan,
        ...(accountId ? { accountId: validation.id(accountId, 'ACC') } : { login: validation.text(login, 'Login'), password: validation.password(password) }),
        ...values, registeredAt: buildRegisteredAt(str('data'), str('hora'), now).toISOString(), actorId });
      return this.publishChanges(interaction, `✅ Venda **${safe(sale.id)}** registrada.\nConta: ${safe(sale.accountId)}\nValor: **${catalog.money(sale.priceCents)}**\nVencimento: **${formatBR(sale.expiresAt)}**`);
    }

    if (command === 'renovar') {
      const saleId = validation.id(str('venda'), 'VEN');
      const sale = await this.store.getRecord(guildId, 'vendas', saleId);
      if (!sale) throw new Error('Venda não encontrada.');
      const renewal = await this.store.renewSale(guildId, { saleId, plan: str('plano'), ...validation.amounts(sale.tool, str('plano'), number('valor'), number('desconto')), registeredAt, actorId });
      return this.publishChanges(interaction, `✅ Renovação **${safe(renewal.id)}** registrada para ${safe(saleId)}.\nValor: **${catalog.money(renewal.priceCents)}**\nNovo vencimento: **${formatBR(renewal.expiresAt)}**`);
    }

    if (command === 'troca') {
      if (!Object.hasOwn(catalog.TOOLS, str('ferramenta'))) throw new Error('Ferramenta inválida.');
      const saleId = str('venda') ? validation.id(str('venda'), 'VEN') : undefined;
      const sale = saleId ? await this.store.getRecord(guildId, 'vendas', saleId) : null;
      if (saleId && !sale) throw new Error('Venda não encontrada.');
      if (sale && sale.tool !== str('ferramenta')) throw new Error('A ferramenta não corresponde à venda informada.');
      const record = await this.store.createTrade(guildId, { client: validation.text(str('cliente'), 'Cliente'), tool: str('ferramenta'), reason: validation.text(str('motivo'), 'Motivo', 300), observation: str('observacao') ? validation.text(str('observacao'), 'Observação', 500) : '', saleId, registeredAt, actorId });
      return this.publishChanges(interaction, `✅ Troca **${safe(record.id)}** registrada.`);
    }

    if (['troca-senha', 'trocar-senhas'].includes(command)) {
      validation.confirmed(option(interaction, 'Boolean', 'confirmada'));
      const newPassword = validation.password(str('nova_senha'));
      await this.store.expireSales(guildId, registeredAt);
      if (command === 'troca-senha') {
        await this.store.updatePassword(guildId, { expirationId: validation.id(str('vencimento'), 'VENC'), newPassword, actorId });
        return this.publishChanges(interaction, '✅ Troca externa de senha registrada. A conta continua vinculada à venda; use /trocar-senhas para liberar o vencimento.');
      }
      const expirationIds = [...new Set(validation.text(str('vencimentos'), 'Vencimentos', 2000).split(',').map(value => validation.id(value.trim(), 'VENC')))];
      if (expirationIds.length > 100) throw new Error('Processe até 100 contas por comando.');
      const result = await this.store.releaseAccounts(guildId, { expirationIds, newPassword, actorId, registeredAt });
      const lines = [`✅ ${result.changed.length} conta(s) liberada(s).`];
      for (const record of result.changed) lines.push(`${safe(record.id)} — ${safe(record.tool)} — ${safe(record.login)}`);
      for (const error of result.errors) lines.push(`⚠️ ${safe(error.id)}: ${safe(error.message)}`);
      return this.publishChanges(interaction, lines.join('\n'));
    }

    if (command === 'estoque') {
      await this.store.expireSales(guildId, registeredAt);
      const accounts = await this.store.listAccounts(guildId, { tool: str('ferramenta') || undefined });
      const sales = await this.store.listRecords(guildId, 'vendas');
      const expired = new Set(sales.filter(sale => sale.status === 'expired').map(sale => sale.id));
      const tools = str('ferramenta') ? [str('ferramenta')] : Object.keys(catalog.TOOLS);
      const lines = ['📦 **ESTOQUE**'];
      for (const tool of tools) {
        const rows = accounts.filter(account => account.tool === tool);
        lines.push(`\n**${safe(tool)}**`, `Disponíveis: ${rows.filter(a => a.status === 'available' && !a.pendingDelivery).length}`, `Em uso: ${rows.filter(a => a.status === 'occupied' && !expired.has(a.activeSaleId)).length}`, `Aguardando troca de senha: ${rows.filter(a => expired.has(a.activeSaleId)).length}`, `Aguardando publicação: ${rows.filter(a => a.pendingDelivery).length}`);
      }
      return showPages(interaction, lines.join('\n'));
    }

    if (command === 'vencidas') {
      await this.store.expireSales(guildId, registeredAt);
      const expirations = (await this.store.listRecords(guildId, 'vencimentos')).filter(record => record.status === 'pending' && (!str('ferramenta') || record.tool === str('ferramenta')));
      if (!expirations.length) return showPages(interaction, '✅ Nenhum vencimento pendente de troca de senha.');
      const lines = [];
      for (const record of expirations) {
        const display = await this.store.getDisplayRecord(guildId, 'vencimentos', record.id);
        if (!display?.login || display.password === undefined) throw new Error(`A credencial de ${record.id} não está disponível no histórico.`);
        lines.push(`${display.login}:${display.password}`);
      }
      return interaction.editReply({ content: '', files: [{ name: 'vencidas.txt', attachment: Buffer.from(lines.join('\n'), 'utf8') }], allowedMentions: { parse: [] } });
    }

    if (command === 'ver') {
      const type = str('tipo');
      const id = str('id')?.trim().toUpperCase();
      const rows = id ? [type === 'contas' ? await this.store.getAccount(guildId, id) : await this.store.getRecord(guildId, type, id)].filter(Boolean) : (await this.records(type)).slice(0, 1);
      return showPages(interaction, rows.length ? await Promise.all(rows.map(record => this.displayRecord(record, type))) : 'Registro não encontrado.');
    }

    if (['buscar', 'listar'].includes(command)) {
      const type = str('tipo');
      const query = command === 'buscar' ? validation.text(str('termo'), 'Termo', 200) : undefined;
      const rows = (await this.records(type, query)).slice(0, command === 'listar' ? option(interaction, 'Integer', 'quantidade') || 20 : 100);
      return showPages(interaction, rows.length ? await Promise.all(rows.map(record => this.displayRecord(record))) : 'Nenhum registro encontrado.');
    }

    if (command === 'vencimentos-proximos') {
      const days = option(interaction, 'Integer', 'dias') || 30;
      const sales = (await this.store.listRecords(guildId, 'vendas')).filter(sale => sale.status === 'active' && Date.parse(sale.expiresAt) >= now.getTime() && Date.parse(sale.expiresAt) <= now.getTime() + days * 86_400_000);
      sales.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
      return showPages(interaction, sales.length ? sales.map(sale => recordBlock(`${safe(sale.id)} — ${safe(sale.client)} — ${safe(sale.tool)}\n${formatBR(sale.expiresAt)}`)) : 'Nenhum vencimento no período informado.');
    }

    if (command === 'painel') return showPages(interaction, dashboardText(await this.records('tudo'), await this.store.listAccounts(guildId), now));

    if (command === 'auditoria') {
      const audit = await this.store.listAudit(guildId, { limit: option(interaction, 'Integer', 'quantidade') || 30 });
      return showPages(interaction, audit.length ? audit.map(event => recordBlock(`${formatBR(event.registeredAt || event.at)} — ${safe(event.action)}\nRegistro: ${safe(event.entity)} — Responsável: ${safe(event.actorId || 'sistema')}`)) : 'Nenhuma ação registrada.');
    }

    if (command === 'alertas') {
      const config = await this.store.getConfig(guildId, 'alerts', { enabled: true });
      const enabled = option(interaction, 'Boolean', 'habilitado');
      const leadMinutes = option(interaction, 'Integer', 'antecedencia');
      if (enabled != null) config.enabled = enabled;
      if (leadMinutes != null) config.leadMinutes = leadMinutes;
      if (enabled != null || leadMinutes != null) await this.store.setConfig(guildId, 'alerts', config, { actorId });
      return showPages(interaction, `🔔 Alertas ${config.enabled ? 'ativados' : 'desativados'}. Antecedência: ${config.leadMinutes ? `${config.leadMinutes} minuto(s)` : '60 minutos para 12 horas; 24 horas para os demais planos'}.`);
    }

    if (command === 'exportar') {
      let rows = await this.records(str('tipo') || 'tudo');
      const start = str('inicio') ? parseDateOnlyBR(str('inicio')) : null;
      const end = str('fim') ? parseDateOnlyBR(str('fim')) : null;
      if ((str('inicio') && !start) || (str('fim') && !end) || (start && end && start > end)) throw new Error('Período inválido. Use DD/MM/AAAA.');
      if (start || end) rows = rows.filter(row => { const date = Date.parse(row.registeredAt || row.createdAt); return Number.isFinite(date) && (!start || date >= start.getTime()) && (!end || date < end.getTime() + 86_400_000); });
      return showPages(interaction, `📄 ${rows.length} registro(s) exportado(s).`, { files: [{ attachment: exportCsv(rows), name: 'unlock-facil.csv' }] });
    }

    throw new Error('Comando desatualizado. Atualize os comandos com npm run deploy.');
  }

  async tick(guild) {
    if (this.runningTick || this.stopping) return this.runningTick;
    this.runningTick = (async () => {
      const channels = await this.store.getConfig(this.guildId, 'channels', {});
      if (!channels.painel || !channels.backups || this.requiresMigration || await this.store.getConfig(this.guildId, 'migrationRequired', false)) return;
      await this.store.expireSales(this.guildId, this.clock().toISOString());
      await this.transport.reminders(guild);
      await this.transport.flush(guild);
      const lastBackup = await this.store.getConfig(this.guildId, 'lastBackupAt', null);
      if (!lastBackup || this.clock().getTime() - Date.parse(lastBackup) >= 86_400_000) {
        await this.transport.backup(guild);
        await this.store.setConfig(this.guildId, 'lastBackupAt', this.clock().toISOString());
      }
      await this.store.checkpointIfNeeded?.();
    })();
    try { await this.runningTick; } finally { this.runningTick = null; }
  }
}

module.exports = { BotApp, hasRole };

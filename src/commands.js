const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { toolChoices } = require('./catalog');

const ADMIN_COMMANDS = new Set(['configurar', 'migrar', 'backup', 'restaurar', 'auditoria', 'alertas']);
const MUTATING_COMMANDS = new Set([
  'configurar', 'migrar', 'restaurar', 'conta', 'vender', 'renovar',
  'editar-venda', 'troca', 'troca-senha', 'trocar-senhas', 'alertas'
]);

const TYPES = [
  { name: 'Vendas', value: 'vendas' },
  { name: 'Vencimentos', value: 'vencimentos' },
  { name: 'Trocas', value: 'trocas' },
  { name: 'Renovações', value: 'renovacoes' },
  { name: 'Contas', value: 'contas' }
];

function command(name, description) {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description);
  if (ADMIN_COMMANDS.has(name)) builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return builder;
}

function string(builder, name, description, required = false, maxLength = 100, minLength = 1) {
  return builder.addStringOption(option => option.setName(name).setDescription(description)
    .setRequired(required).setMinLength(minLength).setMaxLength(maxLength));
}

function tool(builder, required = false) {
  return builder.addStringOption(option => option.setName('ferramenta')
    .setDescription('Selecione a ferramenta').setRequired(required).addChoices(...toolChoices()));
}

function plan(builder, name = 'plano', required = true) {
  return builder.addStringOption(option => option.setName(name)
    .setDescription('Escolha o plano sugerido, com o preço da ferramenta')
    .setRequired(required).setAutocomplete(true).setMinLength(1).setMaxLength(32));
}

function money(builder) {
  return builder
    .addNumberOption(option => option.setName('valor')
      .setDescription('Preço antes do desconto, em reais; omitido usa a tabela')
      .setMinValue(0).setMaxValue(1000000))
    .addNumberOption(option => option.setName('desconto')
      .setDescription('Desconto em reais, subtraído do valor')
      .setMinValue(0).setMaxValue(1000000));
}

function confirmation(builder) {
  return builder.addBooleanOption(option => option.setName('confirmada')
    .setDescription('Confirma que você já alterou a senha na ferramenta externa')
    .setRequired(true));
}

function type(builder, required = true, all = false) {
  return builder.addStringOption(option => option.setName('tipo')
    .setDescription('Tipo de registro').setRequired(required)
    .addChoices(...(all ? [{ name: 'Tudo', value: 'tudo' }, ...TYPES] : TYPES)));
}

function sale(name) {
  const builder = command(name, 'Registra a venda, reserva a conta e calcula o vencimento');
  string(builder, 'cliente', 'Nome ou contato do cliente', true);
  tool(builder, true);
  plan(builder);
  string(builder, 'conta', 'ID ACC da conta disponível; alternativa a login e senha', false, 64);
  string(builder, 'login', 'Login manual; preencha também senha e omita conta', false);
  string(builder, 'senha', 'Senha exata da conta manual', false, 200);
  money(builder);
  string(builder, 'data', 'Data DD/MM/AAAA; omitida usa a data atual', false, 10, 10);
  string(builder, 'hora', 'Hora HH:MM em São Paulo; omitida usa a hora atual', false, 5, 5);
  return builder;
}

function buildCommands() {
  const configure = command('configurar', 'Configura canais privados e cargos da equipe; selecione cargos, não usuários')
    .addRoleOption(option => option.setName('administrador')
      .setDescription('Cargo da sua equipe, ex.: Administração. Atribua a você; não use @everyone ou cargo do bot'))
    .addRoleOption(option => option.setName('vendedor')
      .setDescription('Cargo das pessoas que vendem, ex.: Vendedores. Não selecione @everyone ou cargo do bot'));

  const account = command('conta', 'Administra o estoque de contas')
    .addSubcommand(subcommand => {
      subcommand.setName('adicionar').setDescription('Adiciona uma conta disponível ao estoque');
      tool(subcommand, true);
      string(subcommand, 'login', 'Login exato da conta', true);
      string(subcommand, 'senha', 'Senha exata da conta', true, 200);
      return subcommand;
    })
    .addSubcommand(subcommand => {
      subcommand.setName('listar').setDescription('Consulta contas por ferramenta e situação');
      tool(subcommand);
      subcommand.addStringOption(option => option.setName('status').setDescription('Situação da conta')
        .addChoices(
          { name: 'Disponível', value: 'disponivel' },
          { name: 'Em uso', value: 'em-uso' },
          { name: 'Aguardando troca de senha', value: 'aguardando-senha' }
        ));
      return subcommand;
    })
    .addSubcommand(subcommand => {
      subcommand.setName('senha').setDescription('Registra uma senha alterada externamente, sem liberar a conta');
      string(subcommand, 'conta', 'ID ACC da conta', true, 64);
      string(subcommand, 'nova_senha', 'Nova senha exata da conta', true, 200);
      confirmation(subcommand);
      return subcommand;
    });

  const stock = tool(command('estoque', 'Mostra contas disponíveis, em uso e aguardando troca de senha'));

  const renew = command('renovar', 'Registra uma receita de renovação sem alterar a venda original');
  string(renew, 'venda', 'ID VEN da venda que será renovada', true, 64);
  plan(renew);
  money(renew);

  const edit = command('editar-venda', 'Corrige uma venda existente, mantendo seu ID e registrando a edição');
  string(edit, 'venda', 'ID VEN da venda', true, 64);
  string(edit, 'cliente', 'Novo nome ou contato do cliente');
  plan(edit, 'plano', false);
  money(edit);
  string(edit, 'data', 'Corrigir data do registro DD/MM/AAAA', false, 10, 10);
  string(edit, 'hora', 'Corrigir hora do registro HH:MM', false, 5, 5);
  string(edit, 'vencimento', 'Corrigir data do vencimento DD/MM/AAAA', false, 10, 10);
  string(edit, 'hora_vencimento', 'Corrigir hora do vencimento HH:MM', false, 5, 5);
  string(edit, 'login', 'Corrigir login da conta vinculada');
  string(edit, 'senha', 'Corrigir senha exata da conta vinculada', false, 200);

  const replacement = command('troca', 'Substitui a conta da venda e registra os planos anterior e novo');
  string(replacement, 'venda', 'ID VEN da venda cuja conta será substituída', true, 64);
  plan(replacement, 'plano_anterior');
  plan(replacement, 'plano_novo');
  string(replacement, 'login', 'Login da conta que será colocada na venda', true);
  string(replacement, 'senha', 'Senha exata da nova conta', true, 200);
  string(replacement, 'motivo', 'Motivo da troca', false, 300);
  string(replacement, 'observacao', 'Observação adicional', false, 500);

  const password = command('troca-senha', 'Registra uma troca externa de senha sem liberar a conta');
  string(password, 'vencimento', 'ID VENC do vencimento', true, 64);
  string(password, 'nova_senha', 'Nova senha exata da conta', true, 200);
  confirmation(password);

  const passwords = command('trocar-senhas', 'Confirma a troca externa e libera contas vencidas para o estoque');
  string(passwords, 'vencimentos', 'IDs VENC separados por vírgula; máximo de 100', true, 2000);
  string(passwords, 'nova_senha', 'Nova senha exata para todas as contas indicadas', true, 200);
  confirmation(passwords);

  const expired = tool(command('vencidas', 'Lista vencimentos pendentes por ferramenta'));
  const view = type(command('ver', 'Consulta um registro ou o registro mais recente do tipo'));
  string(view, 'id', 'ID do registro; omitido mostra o mais recente', false, 64);

  const search = command('buscar', 'Busca por cliente, login, ID ou texto');
  string(search, 'termo', 'Termo da busca', true, 200);
  type(search, false, true);

  const list = type(command('listar', 'Lista registros recentes com navegação por páginas'))
    .addIntegerOption(option => option.setName('quantidade').setDescription('Quantidade de registros, de 1 a 100')
      .setMinValue(1).setMaxValue(100));

  const upcoming = command('vencimentos-proximos', 'Lista vencimentos nos próximos dias')
    .addIntegerOption(option => option.setName('dias').setDescription('Próximos dias, de 1 a 365')
      .setMinValue(1).setMaxValue(365));

  const audit = command('auditoria', 'Consulta responsáveis e ações recentes, sem expor senhas')
    .addIntegerOption(option => option.setName('quantidade').setDescription('Quantidade de ações, de 1 a 100')
      .setMinValue(1).setMaxValue(100));

  const alerts = command('alertas', 'Consulta ou configura avisos antecipados de vencimento')
    .addBooleanOption(option => option.setName('habilitado').setDescription('Ativa ou desativa os avisos antecipados'))
    .addIntegerOption(option => option.setName('antecedencia').setDescription('Antecedência em minutos, de 1 a 43200')
      .setMinValue(1).setMaxValue(43200));

  const exporting = type(command('exportar', 'Exporta registros para CSV sem senhas'), false);
  string(exporting, 'inicio', 'Início do período DD/MM/AAAA', false, 10, 10);
  string(exporting, 'fim', 'Fim do período DD/MM/AAAA', false, 10, 10);

  const restore = command('restaurar', 'Restaura um backup criptografado somente em um canal de dados vazio')
    .addAttachmentOption(option => option.setName('arquivo').setDescription('Arquivo JSON gerado por /backup')
      .setRequired(true))
    .addBooleanOption(option => option.setName('confirmada')
      .setDescription('Confirma a restauração em uma instância sem registros').setRequired(true));

  return [
    configure,
    command('migrar', 'Importa o histórico legado escrito por este bot, preservando os canais'),
    command('backup', 'Envia uma cópia criptografada dos dados para o canal privado'),
    restore, audit, account, stock, sale('vender'), renew, edit,
    replacement, password, passwords, expired, view, search, list, upcoming,
    command('painel', 'Mostra estoque, pendências e receitas registradas'), alerts, exporting
  ];
}

module.exports = { buildCommands, ADMIN_COMMANDS, MUTATING_COMMANDS };

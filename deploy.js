require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');


/* =========================================================
   ESCOLHAS
========================================================= */

const ferramentaChoices = [
  {
    name: 'Unlock Tool',
    value: 'Unlock Tool'
  },
  {
    name: 'TSM Tool',
    value: 'TSM Tool'
  },
  {
    name: 'AMT Tool',
    value: 'AMT Tool'
  }
];


const planoChoices = [
  {
    name: '12 horas',
    value: '12 horas'
  },
  {
    name: '3 meses',
    value: '3 meses'
  },
  {
    name: '12 meses',
    value: '12 meses'
  }
];


const tipoChoices = [
  {
    name: 'Vendas',
    value: 'vendas'
  },
  {
    name: 'Vencimentos',
    value: 'vencimentos'
  },
  {
    name: 'Trocas',
    value: 'trocas'
  },
  {
    name: 'Renovações',
    value: 'renovacoes'
  }
];


/* =========================================================
   COMANDOS
========================================================= */

const commands = [

  /* =====================================================
     CONFIGURAR
  ===================================================== */

  new SlashCommandBuilder()
    .setName('configurar')
    .setDescription(
      'Cria ou atualiza a estrutura do Unlock Fácil'
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),


  /* =====================================================
     VENDA
  ===================================================== */

  new SlashCommandBuilder()
    .setName('venda')
    .setDescription(
      'Registra uma venda e calcula o vencimento'
    )

    .addStringOption(o =>
      o
        .setName('cliente')
        .setDescription(
          'Nome ou contato do cliente'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('ferramenta')
        .setDescription(
          'Selecione a ferramenta'
        )
        .setRequired(true)
        .addChoices(
          ...ferramentaChoices
        )
    )

    .addStringOption(o =>
      o
        .setName('plano')
        .setDescription(
          'Selecione o plano'
        )
        .setRequired(true)
        .addChoices(
          ...planoChoices
        )
    )

    .addStringOption(o =>
      o
        .setName('login')
        .setDescription(
          'Login da conta'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('senha')
        .setDescription(
          'Senha da conta'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('data')
        .setDescription(
          'Data DD/MM/AAAA (opcional)'
        )
        .setRequired(false)
    )

    .addStringOption(o =>
      o
        .setName('hora')
        .setDescription(
          'Hora HH:MM (opcional)'
        )
        .setRequired(false)
    ),


  /* =====================================================
     TROCA
  ===================================================== */

  new SlashCommandBuilder()
    .setName('troca')
    .setDescription(
      'Registra uma troca'
    )

    .addStringOption(o =>
      o
        .setName('cliente')
        .setDescription(
          'Nome ou contato do cliente'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('ferramenta')
        .setDescription(
          'Ferramenta'
        )
        .setRequired(true)
        .addChoices(
          ...ferramentaChoices
        )
    )

    .addStringOption(o =>
      o
        .setName('motivo')
        .setDescription(
          'Motivo da troca'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('observacao')
        .setDescription(
          'Observação (opcional)'
        )
        .setRequired(false)
    ),


  /* =====================================================
     TROCA-SENHA
     UMA CONTA
  ===================================================== */

  new SlashCommandBuilder()
    .setName('troca-senha')
    .setDescription(
      'Troca a senha de uma única conta'
    )

    .addStringOption(o =>
      o
        .setName('vencimento')
        .setDescription(
          'ID do vencimento. Ex.: VENC-001'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('nova_senha')
        .setDescription(
          'Nova senha da conta'
        )
        .setRequired(true)
    ),


  /* =====================================================
     TROCAR-SENHAS
     VÁRIAS CONTAS
  ===================================================== */

  new SlashCommandBuilder()
    .setName('trocar-senhas')
    .setDescription(
      'Troca várias contas vencidas em bloco'
    )

    .addStringOption(o =>
      o
        .setName('vencimentos')
        .setDescription(
          'IDs separados por vírgula'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('nova_senha')
        .setDescription(
          'Nova senha para todas as contas'
        )
        .setRequired(true)
    ),


  /* =====================================================
     VENCIDAS
  ===================================================== */

  new SlashCommandBuilder()
    .setName('vencidas')
    .setDescription(
      'Mostra as contas vencidas separadas por ferramenta'
    ),


  /* =====================================================
     RENOVAR
  ===================================================== */

  new SlashCommandBuilder()
    .setName('renovar')
    .setDescription(
      'Registra uma renovação'
    )

    .addStringOption(o =>
      o
        .setName('cliente')
        .setDescription(
          'Nome ou contato do cliente'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('ferramenta')
        .setDescription(
          'Selecione a ferramenta'
        )
        .setRequired(true)
        .addChoices(
          ...ferramentaChoices
        )
    )

    .addStringOption(o =>
      o
        .setName('plano')
        .setDescription(
          'Selecione o novo plano'
        )
        .setRequired(true)
        .addChoices(
          ...planoChoices
        )
    ),


  /* =====================================================
     VER
  ===================================================== */

  new SlashCommandBuilder()
    .setName('ver')
    .setDescription(
      'Consulta registros'
    )

    .addStringOption(o =>
      o
        .setName('tipo')
        .setDescription(
          'Tipo de registro'
        )
        .setRequired(true)
        .addChoices(
          ...tipoChoices
        )
    )

    .addStringOption(o =>
      o
        .setName('id')
        .setDescription(
          'ID do registro'
        )
        .setRequired(false)
    ),


  /* =====================================================
     BUSCAR
  ===================================================== */

  new SlashCommandBuilder()
    .setName('buscar')
    .setDescription(
      'Busca registros pelo cliente, login, ID ou texto'
    )

    .addStringOption(o =>
      o
        .setName('termo')
        .setDescription(
          'Termo da busca'
        )
        .setRequired(true)
    )

    .addStringOption(o =>
      o
        .setName('tipo')
        .setDescription(
          'Onde buscar'
        )
        .setRequired(false)
        .addChoices(
          {
            name: 'Tudo',
            value: 'tudo'
          },
          ...tipoChoices
        )
    ),


  /* =====================================================
     LISTAR
  ===================================================== */

  new SlashCommandBuilder()
    .setName('listar')
    .setDescription(
      'Lista registros recentes'
    )

    .addStringOption(o =>
      o
        .setName('tipo')
        .setDescription(
          'Tipo de registro'
        )
        .setRequired(true)
        .addChoices(
          ...tipoChoices
        )
    )

    .addIntegerOption(o =>
      o
        .setName('quantidade')
        .setDescription(
          'Quantidade de 1 a 20'
        )
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    ),


  /* =====================================================
     VENCIMENTOS PRÓXIMOS
  ===================================================== */

  new SlashCommandBuilder()
    .setName('vencimentos-proximos')
    .setDescription(
      'Mostra vencimentos próximos'
    )

    .addIntegerOption(o =>
      o
        .setName('dias')
        .setDescription(
          'Próximos X dias'
        )
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(365)
    ),


  /* =====================================================
     PAINEL
  ===================================================== */

  new SlashCommandBuilder()
    .setName('painel')
    .setDescription(
      'Mostra o painel geral'
    )

].map(
  command =>
    command.setDMPermission(false)
);


/* =========================================================
   REGISTRO DOS COMANDOS
========================================================= */

(async () => {

  try {

    if (
      !process.env.DISCORD_TOKEN
    ) {

      throw new Error(
        'DISCORD_TOKEN não foi configurado no .env.'
      );
    }


    if (
      !process.env.CLIENT_ID
    ) {

      throw new Error(
        'CLIENT_ID não foi configurado no .env.'
      );
    }


    if (
      !process.env.GUILD_ID
    ) {

      throw new Error(
        'GUILD_ID não foi configurado no .env.'
      );
    }


    const rest =
      new REST({
        version: '10'
      }).setToken(
        process.env.DISCORD_TOKEN
      );


    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      {
        body:
          commands.map(
            command =>
              command.toJSON()
          )
      }
    );


    console.log(
      '✅ Comandos registrados/atualizados com sucesso.'
    );

  } catch (error) {

    console.error(
      '❌ Falha ao registrar comandos:',
      error
    );

    process.exitCode = 1;
  }

})();
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  MessageFlags
} = require('discord.js');

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

/* =========================================================
   CONFIGURAÇÕES
========================================================= */

const CHANNELS = {
  painel: '⚙️・painel',
  vendas: '💰・vendas',
  vencimentos: '⏰・vencimentos',
  trocas: '🔄・trocas',
  renovacoes: '♻️・renovações',

  contasLivres: '📁・CONTAS LIVRES',

  unlockTool: '🆓・unlock-tool',
  tsmTool: '🆓・tsm-tool',
  amtTool: '🆓・amt-tool',

  comandos: '📖・comandos'
};

const LEGACY_CHANNELS = [
  '🔐・trocas-de-senha',
  '🆓・contas-livres'
];

const CATEGORY =
  '📁 UNLOCK FÁCIL';

const PREFIX = {
  vendas: 'VEN',
  vencimentos: 'VENC',
  trocas: 'TRC',
  renovacoes: 'REN'
};

const TZ =
  'America/Sao_Paulo';

const VALID_PLANS = {
  'Unlock Tool': [
    '12 horas',
    '3 meses',
    '12 meses'
  ],

  'TSM Tool': [
    '12 horas',
    '3 meses'
  ],

  'AMT Tool': [
    '12 horas',
    '3 meses',
    '12 meses'
  ]
};

const EXPIRATION_CHECK_INTERVAL =
  30 * 1000;

const processingGuilds =
  new Set();

/* =========================================================
   CANAIS
========================================================= */

function getChannel(
  guild,
  key
) {
  return guild.channels.cache.find(
    channel =>
      channel.name === CHANNELS[key] &&
      channel.type === ChannelType.GuildText
  );
}

function getFreeAccountChannel(
  guild,
  tool
) {
  if (tool === 'Unlock Tool') {
    return getChannel(
      guild,
      'unlockTool'
    );
  }

  if (tool === 'TSM Tool') {
    return getChannel(
      guild,
      'tsmTool'
    );
  }

  if (tool === 'AMT Tool') {
    return getChannel(
      guild,
      'amtTool'
    );
  }

  return null;
}

/* =========================================================
   MENSAGENS
========================================================= */

async function fetchAllMessages(
  channel
) {
  if (!channel) {
    return [];
  }

  const messages = [];
  let before;

  for (
    let page = 0;
    page < 20;
    page++
  ) {
    const options = {
      limit: 100
    };

    if (before) {
      options.before =
        before;
    }

    const batch =
      await channel.messages.fetch(
        options
      );

    if (!batch.size) {
      break;
    }

    messages.push(
      ...batch.values()
    );

    if (
      batch.size < 100
    ) {
      break;
    }

    before =
      batch.last().id;
  }

  return messages;
}

/* =========================================================
   DATAS / HORÁRIOS
========================================================= */

function formatBR(
  date
) {
  return new Intl.DateTimeFormat(
    'pt-BR',
    {
      timeZone: TZ,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }
  )
    .format(date)
    .replace(',', '');
}

function dateTimeBR(
  date
) {
  return formatBR(date);
}

function parseDateOnlyBR(
  value
) {
  if (
    !/^\d{2}\/\d{2}\/\d{4}$/.test(
      value
    )
  ) {
    return null;
  }

  const [
    day,
    month,
    year
  ] =
    value
      .split('/')
      .map(Number);

  const dt =
    new Date(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00-03:00`
    );

  if (
    Number.isNaN(
      dt.getTime()
    )
  ) {
    return null;
  }

  const checkDate =
    new Intl.DateTimeFormat(
      'pt-BR',
      {
        timeZone: TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }
    ).format(dt);

  if (
    checkDate !== value
  ) {
    return null;
  }

  return dt;
}

function parseTimeBR(
  value
) {
  if (
    !/^\d{2}:\d{2}$/.test(
      value
    )
  ) {
    return null;
  }

  const [
    hour,
    minute
  ] =
    value
      .split(':')
      .map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return {
    hour,
    minute
  };
}

function parseDateTimeBR(
  value
) {
  if (
    !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(
      value
    )
  ) {
    return null;
  }

  const match =
    value.match(
      /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/
    );

  if (!match) {
    return null;
  }

  const [
    ,
    day,
    month,
    year,
    hour,
    minute
  ] = match;

  const dt =
    new Date(
      `${year}-${month}-${day}T${hour}:${minute}:00-03:00`
    );

  if (
    Number.isNaN(
      dt.getTime()
    )
  ) {
    return null;
  }

  const check =
    new Intl.DateTimeFormat(
      'pt-BR',
      {
        timeZone: TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }
    )
      .format(dt)
      .replace(',', '');

  if (
    check !== value
  ) {
    return null;
  }

  return dt;
}

function buildRegisteredAt(
  data,
  hora
) {
  const now =
    new Date();

  if (
    !data &&
    !hora
  ) {
    return now;
  }

  const nowBR =
    new Intl.DateTimeFormat(
      'pt-BR',
      {
        timeZone: TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }
    )
      .format(now)
      .replace(',', '');

  const [
    currentDate,
    currentTime
  ] =
    nowBR.split(' ');

  const finalDate =
    data || currentDate;

  const finalTime =
    hora || currentTime;

  if (
    !parseDateOnlyBR(
      finalDate
    )
  ) {
    throw new Error(
      'Data inválida. Use o formato DD/MM/AAAA.'
    );
  }

  if (
    !parseTimeBR(
      finalTime
    )
  ) {
    throw new Error(
      'Hora inválida. Use o formato HH:MM.'
    );
  }

  const result =
    parseDateTimeBR(
      `${finalDate} ${finalTime}`
    );

  if (!result) {
    throw new Error(
      'Data ou hora inválida. Verifique os valores informados.'
    );
  }

  return result;
}

function addMonths(
  date,
  months
) {
  const shifted =
    new Date(
      date.getTime() +
      3 * 60 * 60 * 1000
    );

  const year =
    shifted.getUTCFullYear();

  const month =
    shifted.getUTCMonth();

  const day =
    shifted.getUTCDate();

  const hour =
    shifted.getUTCHours();

  const minute =
    shifted.getUTCMinutes();

  const second =
    shifted.getUTCSeconds();

  const ms =
    shifted.getUTCMilliseconds();

  const target =
    new Date(
      Date.UTC(
        year,
        month + months + 1,
        0,
        hour,
        minute,
        second,
        ms
      )
    );

  const lastDay =
    target.getUTCDate();

  const finalDay =
    Math.min(
      day,
      lastDay
    );

  const resultPseudoUTC =
    new Date(
      Date.UTC(
        year,
        month + months,
        finalDay,
        hour,
        minute,
        second,
        ms
      )
    );

  return new Date(
    resultPseudoUTC.getTime() -
    3 * 60 * 60 * 1000
  );
}

/* =========================================================
   PLANOS
========================================================= */

function validatePlan(
  tool,
  plan
) {
  if (
    !VALID_PLANS[tool]
  ) {
    throw new Error(
      `Ferramenta inválida: ${tool}.`
    );
  }

  if (
    !VALID_PLANS[tool].includes(
      plan
    )
  ) {
    throw new Error(
      `O plano ${plan} não está disponível para ${tool}.`
    );
  }
}

function calculateExpiration(
  plan,
  registeredAt
) {
  if (
    plan === '12 horas'
  ) {
    return new Date(
      registeredAt.getTime() +
      12 * 60 * 60 * 1000
    );
  }

  if (
    plan === '3 meses'
  ) {
    return addMonths(
      registeredAt,
      3
    );
  }

  if (
    plan === '12 meses'
  ) {
    return addMonths(
      registeredAt,
      12
    );
  }

  throw new Error(
    'Plano inválido.'
  );
}

/* =========================================================
   IDs
========================================================= */

async function nextId(
  channel,
  prefix
) {
  let max = 0;

  const messages =
    await fetchAllMessages(
      channel
    );

  for (
    const message of messages
  ) {
    const match =
      message.content.match(
        new RegExp(
          `🔖 ID: ${prefix}-(\\d+)`
        )
      );

    if (match) {
      max =
        Math.max(
          max,
          Number(match[1])
        );
    }
  }

  return `${prefix}-${String(
    max + 1
  ).padStart(3, '0')}`;
}

/* =========================================================
   FORMATAÇÃO
========================================================= */

function block(
  title,
  fields
) {
  return [
    '━━━━━━━━━━━━━━━━━━━━━━',
    `📌 ${title}`,
    ...fields.map(
      ([key, value]) =>
        `${key}: ${value ?? '-'}`
    ),
    '━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

async function createRecord(
  guild,
  type,
  title,
  fields
) {
  const channel =
    getChannel(
      guild,
      type
    );

  if (!channel) {
    throw new Error(
      'A estrutura ainda não foi configurada. Use /configurar primeiro.'
    );
  }

  const id =
    await nextId(
      channel,
      PREFIX[type]
    );

  const content =
    block(
      title,
      [
        [
          '🔖 ID',
          id
        ],
        ...fields
      ]
    );

  const message =
    await channel.send(
      content
    );

  return {
    id,
    message
  };
}

/* =========================================================
   BUSCA DE REGISTROS
========================================================= */

async function findRecord(
  guild,
  type,
  id
) {
  const channel =
    getChannel(
      guild,
      type
    );

  if (!channel) {
    return null;
  }

  const wanted =
    id
      .trim()
      .toUpperCase();

  const messages =
    await fetchAllMessages(
      channel
    );

  return messages.find(
    message => {
      const match =
        message.content.match(
          /^🔖 ID: ([A-Z]+-\d+)$/m
        );

      return (
        match &&
        match[1] === wanted
      );
    }
  ) || null;
}

/* =========================================================
   LABELS
========================================================= */

function typeLabel(
  type
) {
  return {
    vendas: '💰 Vendas',
    vencimentos: '⏰ Vencimentos',
    trocas: '🔄 Trocas',
    renovacoes: '♻️ Renovações'
  }[type] || type;
}

/* =========================================================
   CONFIGURAÇÃO
========================================================= */

async function setup(
  guild
) {
  let category =
    guild.channels.cache.find(
      channel =>
        channel.name === CATEGORY &&
        channel.type ===
          ChannelType.GuildCategory
    );

  if (!category) {
    category =
      await guild.channels.create({
        name: CATEGORY,
        type: ChannelType.GuildCategory
      });
  }

  for (
    const legacyName of LEGACY_CHANNELS
  ) {
    const oldChannels =
      guild.channels.cache.filter(
        channel =>
          channel.name === legacyName &&
          channel.type ===
            ChannelType.GuildText
      );

    for (
      const oldChannel of oldChannels.values()
    ) {
      try {
        await oldChannel.delete(
          'Canal antigo removido pela nova estrutura do Unlock Fácil'
        );

        console.log(
          `🗑️ Canal antigo removido: ${legacyName}`
        );
      } catch (error) {
        console.error(
          `Não foi possível remover ${legacyName}:`,
          error
        );
      }
    }
  }

  const mainChannels = [
    'painel',
    'vendas',
    'vencimentos',
    'trocas',
    'renovacoes',
    'comandos'
  ];

  for (
    const key of mainChannels
  ) {
    const name =
      CHANNELS[key];

    const exists =
      guild.channels.cache.find(
        channel =>
          channel.name === name &&
          channel.type ===
            ChannelType.GuildText
      );

    if (!exists) {
      await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id
      });
    }
  }

  let freeCategory =
    guild.channels.cache.find(
      channel =>
        channel.name ===
          CHANNELS.contasLivres &&
        channel.type ===
          ChannelType.GuildCategory
    );

  if (!freeCategory) {
    freeCategory =
      await guild.channels.create({
        name:
          CHANNELS.contasLivres,
        type:
          ChannelType.GuildCategory
      });
  }

  const freeChannels = [
    'unlockTool',
    'tsmTool',
    'amtTool'
  ];

  for (
    const key of freeChannels
  ) {
    const name =
      CHANNELS[key];

    const exists =
      guild.channels.cache.find(
        channel =>
          channel.name === name &&
          channel.type ===
            ChannelType.GuildText
      );

    if (!exists) {
      await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: freeCategory.id
      });
    }
  }

  await setupCommandsChannel(
    guild
  );

  return category;
}

/* =========================================================
   MANUAL
========================================================= */

async function setupCommandsChannel(
  guild
) {
  const channel =
    getChannel(
      guild,
      'comandos'
    );

  if (!channel) {
    return;
  }

  const existingMessages =
    await fetchAllMessages(
      channel
    );

  const botMessages =
    existingMessages.filter(
      message =>
        message.author.id ===
        client.user?.id
    );

  if (
    botMessages.length > 0
  ) {
    return;
  }

  const content = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '📖 **COMANDOS — UNLOCK FÁCIL**',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '⚙️ **COMO USAR**',
    'Execute os comandos no canal `⚙️・painel`.',
    'As respostas dos comandos são privadas.',
    '',
    '📌 **/configurar**',
    'Cria ou atualiza a estrutura do servidor.',
    '',
    '💰 **/venda**',
    'Registra uma nova venda.',
    'A venda fica em `💰・vendas` até o vencimento.',
    'Quando vencer, o bot cria automaticamente o registro em `⏰・vencimentos`.',
    '',
    'Campos:',
    '• cliente',
    '• ferramenta',
    '• plano',
    '• login',
    '• senha',
    '• data — opcional',
    '• hora — opcional',
    '',
    '⏰ **/vencimentos-proximos**',
    'Mostra os vencimentos próximos com base nas vendas.',
    '',
    '🔴 **/vencidas**',
    'Mostra as contas que já venceram e ainda não tiveram a senha trocada.',
    'As contas são separadas por ferramenta:',
    '• `🆓・unlock-tool`',
    '• `🆓・tsm-tool`',
    '• `🆓・amt-tool`',
    '',
    'O resultado é entregue no formato:',
    '`login:senha`',
    '',
    '🔄 **/troca**',
    'Registra uma troca realizada para um cliente.',
    '',
    '🔐 **/troca-senha**',
    'Troca a senha de uma única conta.',
    'A senha é alterada diretamente na venda.',
    '',
    '🔑 **/trocar-senhas**',
    'Troca várias contas vencidas em bloco.',
    'A senha antiga da venda é mantida como histórico.',
    'As novas credenciais são enviadas para o canal da ferramenta.',
    '',
    '♻️ **/renovar**',
    'Registra uma renovação.',
    '',
    '📋 **/ver**',
    'Consulta registros.',
    '',
    '🔎 **/buscar**',
    'Procura registros por cliente, login, ID ou texto.',
    '',
    '📋 **/listar**',
    'Lista registros recentes.',
    '',
    '📊 **/painel**',
    'Mostra a quantidade de registros.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🆓 **CONTAS LIVRES**',
    '`🆓・unlock-tool` — Unlock Tool',
    '`🆓・tsm-tool` — TSM Tool',
    '`🆓・amt-tool` — AMT Tool',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔒 **IMPORTANTE**',
    'Login e senha ficam somente nas vendas.',
    'Os vencimentos possuem apenas o link da venda.',
    'Mantenha os canais restritos à equipe autorizada.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  await channel.send(
    content
  );
}

/* =========================================================
   LEITURA DOS REGISTROS
========================================================= */

function extractExpiration(
  content
) {
  const fullMatch =
    content.match(
      /⏰ VENCIMENTO: (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/
    );

  if (fullMatch) {
    return parseDateTimeBR(
      fullMatch[1]
    );
  }

  const oldMatch =
    content.match(
      /⏰ VENCIMENTO: (\d{2}\/\d{2}\/\d{4})/
    );

  if (oldMatch) {
    return parseDateOnlyBR(
      oldMatch[1]
    );
  }

  return null;
}

function extractClient(
  content
) {
  return content.match(
    /👤 CLIENTE: (.+)/
  )?.[1]?.trim() || null;
}

function extractLogin(
  content
) {
  return content.match(
    /🔐 LOGIN: `?([^`\n]+)`?/
  )?.[1]?.trim() || null;
}

function extractPassword(
  content
) {
  return content.match(
    /🔑 SENHA: `?([^`\n]+)`?/
  )?.[1]?.trim() || null;
}

function extractTool(
  content
) {
  return content.match(
    /🛠️ FERRAMENTA: (.+)/
  )?.[1]?.trim() || null;
}

function extractPlan(
  content
) {
  return content.match(
    /📦 PLANO: (.+)/
  )?.[1]?.trim() || null;
}

function extractSaleId(
  content
) {
  return content.match(
    /^🔖 ID: (VEN-\d+)$/m
  )?.[1] || null;
}

function extractSaleLink(
  content
) {
  return content.match(
    /🔗 VENDA: (https?:\/\/\S+)/
  )?.[1]?.trim() || null;
}

function extractLinkedSaleId(
  content
) {
  return content.match(
    /^🔖 VENDA ID: (VEN-\d+)$/m
  )?.[1] || null;
}

/*
 * Verifica se a conta já teve a senha trocada.
 */
function hasPasswordChanged(
  content
) {
  return content.includes(
    '🔄 STATUS: SENHA TROCADA'
  );
}

/* =========================================================
   VERIFICAR VENCIMENTO
========================================================= */

async function findExpirationBySaleId(
  guild,
  saleId
) {
  const vendasChannel =
    getChannel(
      guild,
      'vendas'
    );

  const vencimentosChannel =
    getChannel(
      guild,
      'vencimentos'
    );

  if (
    !vendasChannel ||
    !vencimentosChannel
  ) {
    return null;
  }

  const saleMessages =
    await fetchAllMessages(
      vendasChannel
    );

  const saleMessage =
    saleMessages.find(
      message =>
        extractSaleId(
          message.content
        ) === saleId
    );

  if (!saleMessage) {
    return null;
  }

  const saleUrl =
    saleMessage.url;

  if (!saleUrl) {
    return null;
  }

  const expirationMessages =
    await fetchAllMessages(
      vencimentosChannel
    );

  return expirationMessages.find(
    message => {
      const linkedSaleId =
        extractLinkedSaleId(
          message.content
        );

      if (
        linkedSaleId ===
        saleId
      ) {
        return true;
      }

      const storedSaleUrl =
        extractSaleLink(
          message.content
        );

      return (
        storedSaleUrl ===
        saleUrl
      );
    }
  ) || null;
}

/* =========================================================
   CRIAR VENCIMENTO
========================================================= */

async function createExpirationFromSale(
  guild,
  saleMessage
) {
  const vencimentosChannel =
    getChannel(
      guild,
      'vencimentos'
    );

  if (!vencimentosChannel) {
    throw new Error(
      'O canal de vencimentos não foi encontrado.'
    );
  }

  const saleId =
    extractSaleId(
      saleMessage.content
    );

  if (!saleId) {
    return null;
  }

  const existing =
    await findExpirationBySaleId(
      guild,
      saleId
    );

  if (existing) {
    return existing;
  }

  const cliente =
    extractClient(
      saleMessage.content
    );

  const ferramenta =
    extractTool(
      saleMessage.content
    );

  const expiration =
    extractExpiration(
      saleMessage.content
    );

  if (
    !cliente ||
    !ferramenta ||
    !expiration
  ) {
    return null;
  }

  const vencimentoId =
    await nextId(
      vencimentosChannel,
      PREFIX.vencimentos
    );

  const content =
    block(
      'VENCIMENTO',
      [
        [
          '🔖 ID',
          vencimentoId
        ],
        [
          '🔖 VENDA ID',
          saleId
        ],
        [
          '👤 CLIENTE',
          cliente
        ],
        [
          '🛠️ FERRAMENTA',
          ferramenta
        ],
        [
          '⏰ VENCIMENTO',
          dateTimeBR(
            expiration
          )
        ],
        [
          '🔗 VENDA',
          saleMessage.url
        ]
      ]
    );

  return vencimentosChannel.send(
    content
  );
}

/* =========================================================
   PROCESSAR VENCIMENTOS AUTOMATICAMENTE
========================================================= */

async function processExpiredSales(
  guild
) {
  if (
    processingGuilds.has(
      guild.id
    )
  ) {
    return;
  }

  processingGuilds.add(
    guild.id
  );

  try {
    const vendasChannel =
      getChannel(
        guild,
        'vendas'
      );

    if (!vendasChannel) {
      return;
    }

    const messages =
      await fetchAllMessages(
        vendasChannel
      );

    const now =
      new Date();

    let created = 0;

    for (
      const message of messages
    ) {
      const saleId =
        extractSaleId(
          message.content
        );

      if (!saleId) {
        continue;
      }

      const expiration =
        extractExpiration(
          message.content
        );

      if (!expiration) {
        continue;
      }

      if (
        expiration.getTime() >
        now.getTime()
      ) {
        continue;
      }

      const existing =
        await findExpirationBySaleId(
          guild,
          saleId
        );

      if (existing) {
        continue;
      }

      try {
        const createdMessage =
          await createExpirationFromSale(
            guild,
            message
          );

        if (createdMessage) {
          created++;

          console.log(
            `⏰ Venda ${saleId} movida para vencimentos.`
          );
        }
      } catch (error) {
        console.error(
          `Erro ao processar ${saleId}:`,
          error
        );
      }
    }

    if (
      created > 0
    ) {
      console.log(
        `⏰ ${created} vencimento(s) criado(s).`
      );
    }
  } finally {
    processingGuilds.delete(
      guild.id
    );
  }
}

/* =========================================================
   BUSCAR VENDA ATIVA
========================================================= */

async function findCurrentSale(
  guild,
  cliente,
  ferramenta = null
) {
  const channel =
    getChannel(
      guild,
      'vendas'
    );

  if (!channel) {
    return null;
  }

  const wantedClient =
    cliente
      .trim()
      .toLowerCase();

  const wantedTool =
    ferramenta
      ?.trim()
      .toLowerCase();

  const messages =
    await fetchAllMessages(
      channel
    );

  const matches = [];

  for (
    const message of messages
  ) {
    const saleClient =
      extractClient(
        message.content
      );

    if (!saleClient) {
      continue;
    }

    if (
      saleClient.toLowerCase() !==
      wantedClient
    ) {
      continue;
    }

    const saleTool =
      extractTool(
        message.content
      );

    if (
      wantedTool &&
      (
        !saleTool ||
        saleTool.toLowerCase() !==
        wantedTool
      )
    ) {
      continue;
    }

    const expiration =
      extractExpiration(
        message.content
      );

    if (!expiration) {
      continue;
    }

    if (
      expiration.getTime() <=
      Date.now()
    ) {
      continue;
    }

    matches.push({
      message,
      expiration
    });
  }

  if (!matches.length) {
    return null;
  }

  matches.sort(
    (a, b) =>
      b.expiration.getTime() -
      a.expiration.getTime()
  );

  return matches[0];
}

/* =========================================================
   LOCALIZAR VENDA PELO LOGIN
========================================================= */

async function findSaleByAccount(
  guild,
  cliente,
  ferramenta,
  login
) {
  const channel =
    getChannel(
      guild,
      'vendas'
    );

  if (!channel) {
    return null;
  }

  const messages =
    await fetchAllMessages(
      channel
    );

  const wantedClient =
    cliente
      .trim()
      .toLowerCase();

  const wantedTool =
    ferramenta
      .trim()
      .toLowerCase();

  const wantedLogin =
    login
      .trim()
      .toLowerCase();

  const matches = [];

  for (
    const message of messages
  ) {
    const content =
      message.content;

    const saleClient =
      extractClient(
        content
      );

    const saleTool =
      extractTool(
        content
      );

    const saleLogin =
      extractLogin(
        content
      );

    if (
      !saleClient ||
      !saleTool ||
      !saleLogin
    ) {
      continue;
    }

    if (
      saleClient.toLowerCase() !==
      wantedClient
    ) {
      continue;
    }

    if (
      saleTool.toLowerCase() !==
      wantedTool
    ) {
      continue;
    }

    if (
      saleLogin.toLowerCase() !==
      wantedLogin
    ) {
      continue;
    }

    matches.push(
      message
    );
  }

  return matches[0] || null;
}

/* =========================================================
   ALTERAR SENHA
========================================================= */

function replacePassword(
  content,
  newPassword
) {
  if (
    !/🔑 SENHA:/.test(
      content
    )
  ) {
    return content;
  }

  return content.replace(
    /🔑 SENHA: `?([^`\n]+)`?/,
    `🔑 SENHA: \`${newPassword}\``
  );
}

/* =========================================================
   ADICIONAR STATUS
========================================================= */

function addPasswordChangedStatus(
  content
) {
  const statusLine =
    '🔄 STATUS: SENHA TROCADA';

  if (
    content.includes(
      statusLine
    )
  ) {
    return content;
  }

  return content.replace(
    /━━━━━━━━━━━━━━━━━━━━━━\s*$/,
    `${statusLine}\n━━━━━━━━━━━━━━━━━━━━━━`
  );
}

/* =========================================================
   TROCA DE SENHA — UMA CONTA
========================================================= */

async function changeSinglePassword(
  guild,
  expirationId,
  newPassword
) {
  const wantedId =
    expirationId
      .trim()
      .toUpperCase();

  if (
    !/^VENC-\d+$/.test(
      wantedId
    )
  ) {
    throw new Error(
      'ID de vencimento inválido. Use, por exemplo, VENC-001.'
    );
  }

  const expirationMessage =
    await findRecord(
      guild,
      'vencimentos',
      wantedId
    );

  if (!expirationMessage) {
    throw new Error(
      `O vencimento ${wantedId} não foi encontrado.`
    );
  }

  const cliente =
    extractClient(
      expirationMessage.content
    );

  const ferramenta =
    extractTool(
      expirationMessage.content
    );

  const saleLink =
    extractSaleLink(
      expirationMessage.content
    );

  if (
    !cliente ||
    !ferramenta ||
    !saleLink
  ) {
    throw new Error(
      `O registro ${wantedId} não possui o link da venda.`
    );
  }

  const saleChannel =
    getChannel(
      guild,
      'vendas'
    );

  const saleMessages =
    await fetchAllMessages(
      saleChannel
    );

  let saleMessage =
    saleMessages.find(
      message =>
        message.url === saleLink
    );

  if (!saleMessage) {
    const wantedClient =
      cliente.toLowerCase();

    const wantedTool =
      ferramenta.toLowerCase();

    saleMessage =
      saleMessages.find(
        message => {
          const saleClient =
            extractClient(
              message.content
            );

          const saleTool =
            extractTool(
              message.content
            );

          return (
            saleClient &&
            saleTool &&
            saleClient.toLowerCase() ===
              wantedClient &&
            saleTool.toLowerCase() ===
              wantedTool
          );
        }
      );
  }

  if (!saleMessage) {
    throw new Error(
      `A venda correspondente ao ${wantedId} não foi encontrada.`
    );
  }

  const newSaleContent =
    replacePassword(
      saleMessage.content,
      newPassword
    );

  if (
    newSaleContent ===
    saleMessage.content
  ) {
    throw new Error(
      `Não foi possível localizar a senha na venda correspondente ao ${wantedId}.`
    );
  }

  await saleMessage.edit(
    newSaleContent
  );

  return {
    id: wantedId,
    client: cliente,
    tool: ferramenta,
    login:
      extractLogin(
        saleMessage.content
      )
  };
}

/* =========================================================
   TROCA DE SENHAS — EM BLOCO
========================================================= */

async function changeExpiredPasswords(
  guild,
  expirationIds,
  newPassword
) {
  const vencimentosChannel =
    getChannel(
      guild,
      'vencimentos'
    );

  if (!vencimentosChannel) {
    throw new Error(
      'O canal de vencimentos não foi encontrado.'
    );
  }

  const messages =
    await fetchAllMessages(
      vencimentosChannel
    );

  const accounts = [];
  const errors = [];

  for (
    const rawId of expirationIds
  ) {
    const wantedId =
      rawId
        .trim()
        .toUpperCase();

    if (
      !/^VENC-\d+$/.test(
        wantedId
      )
    ) {
      errors.push(
        `${wantedId}: ID inválido`
      );

      continue;
    }

    const expirationMessage =
      messages.find(
        message => {
          const match =
            message.content.match(
              /^🔖 ID: (VENC-\d+)$/m
            );

          return (
            match &&
            match[1] ===
              wantedId
          );
        }
      );

    if (!expirationMessage) {
      errors.push(
        `${wantedId}: não encontrado`
      );

      continue;
    }

    const expiration =
      extractExpiration(
        expirationMessage.content
      );

    if (!expiration) {
      errors.push(
        `${wantedId}: vencimento inválido`
      );

      continue;
    }

    if (
      expiration.getTime() >
      Date.now()
    ) {
      errors.push(
        `${wantedId}: conta ainda não venceu`
      );

      continue;
    }

    const cliente =
      extractClient(
        expirationMessage.content
      );

    const ferramenta =
      extractTool(
        expirationMessage.content
      );

    const saleLink =
      extractSaleLink(
        expirationMessage.content
      );

    if (
      !cliente ||
      !ferramenta ||
      !saleLink
    ) {
      errors.push(
        `${wantedId}: dados incompletos`
      );

      continue;
    }

    const vendasChannel =
      getChannel(
        guild,
        'vendas'
      );

    const saleMessages =
      await fetchAllMessages(
        vendasChannel
      );

    let saleMessage =
      saleMessages.find(
        message =>
          message.url ===
          saleLink
      );

    if (!saleMessage) {
      errors.push(
        `${wantedId}: venda original não encontrada`
      );

      continue;
    }

    const login =
      extractLogin(
        saleMessage.content
      );

    if (!login) {
      errors.push(
        `${wantedId}: login não encontrado na venda`
      );

      continue;
    }

    const freeChannel =
      getFreeAccountChannel(
        guild,
        ferramenta
      );

    if (!freeChannel) {
      errors.push(
        `${wantedId}: canal de contas livres da ${ferramenta} não encontrado`
      );

      continue;
    }

    accounts.push({
      id: wantedId,
      client: cliente,
      tool: ferramenta,
      login,
      expirationMessage,
      saleMessage,
      freeChannel
    });
  }

  const uniqueAccounts = [];
  const usedIds = new Set();

  for (
    const account of accounts
  ) {
    if (
      usedIds.has(
        account.id
      )
    ) {
      continue;
    }

    usedIds.add(
      account.id
    );

    uniqueAccounts.push(
      account
    );
  }

  for (
    const account of uniqueAccounts
  ) {
    const newSaleContent =
      addPasswordChangedStatus(
        account.saleMessage.content
      );

    const newExpirationContent =
      addPasswordChangedStatus(
        account.expirationMessage.content
      );

    await account.saleMessage.edit(
      newSaleContent
    );

    await account.expirationMessage.edit(
      newExpirationContent
    );
  }

  const groupedAccounts =
    new Map();

  for (
    const account of uniqueAccounts
  ) {
    if (
      !groupedAccounts.has(
        account.tool
      )
    ) {
      groupedAccounts.set(
        account.tool,
        []
      );
    }

    groupedAccounts
      .get(account.tool)
      .push(account);
  }

  for (
    const [
      tool,
      toolAccounts
    ] of groupedAccounts
  ) {
    const channel =
      getFreeAccountChannel(
        guild,
        tool
      );

    if (!channel) {
      errors.push(
        `${tool}: canal de contas livres não encontrado`
      );

      continue;
    }

    const lines =
      toolAccounts.map(
        account =>
          `${account.login}:${newPassword}`
      );

    let current = '';

    for (
      const line of lines
    ) {
      const candidate =
        current
          ? `${current}\n${line}`
          : line;

      if (
        candidate.length >
          1900 &&
        current
      ) {
        await channel.send(
          current
        );

        current =
          line;
      } else {
        current =
          candidate;
      }
    }

    if (current) {
      await channel.send(
        current
      );
    }
  }

  return {
    changed:
      uniqueAccounts,
    errors
  };
}

/* =========================================================
   CONTAS VENCIDAS
========================================================= */

async function getExpiredAccounts(
  guild
) {
  const vendasChannel =
    getChannel(
      guild,
      'vendas'
    );

  if (!vendasChannel) {
    throw new Error(
      'O canal de vendas não foi encontrado.'
    );
  }

  const messages =
    await fetchAllMessages(
      vendasChannel
    );

  const grouped = {
    'Unlock Tool': [],
    'TSM Tool': [],
    'AMT Tool': []
  };

  for (
    const message of messages
  ) {
    const saleId =
      extractSaleId(
        message.content
      );

    if (!saleId) {
      continue;
    }

    /*
     * NOVO:
     * Ignora contas que já tiveram
     * a senha trocada.
     */
    if (
      hasPasswordChanged(
        message.content
      )
    ) {
      continue;
    }

    const expiration =
      extractExpiration(
        message.content
      );

    if (!expiration) {
      continue;
    }

    /*
     * Somente vendas vencidas.
     */
    if (
      expiration.getTime() >
      Date.now()
    ) {
      continue;
    }

    const login =
      extractLogin(
        message.content
      );

    const password =
      extractPassword(
        message.content
      );

    const tool =
      extractTool(
        message.content
      );

    if (
      !login ||
      !password ||
      !tool
    ) {
      continue;
    }

    if (
      !grouped[tool]
    ) {
      grouped[tool] = [];
    }

    grouped[tool].push({
      saleId,
      login,
      password,
      expiration
    });
  }

  /*
   * Mais antigas primeiro
   * dentro de cada ferramenta.
   */
  for (
    const tool of Object.keys(
      grouped
    )
  ) {
    grouped[tool].sort(
      (a, b) =>
        a.expiration.getTime() -
        b.expiration.getTime()
    );
  }

  return grouped;
}

/* =========================================================
   DIVIDIR TEXTO PARA O DISCORD
========================================================= */

function splitText(
  text,
  maxLength = 1900
) {
  const parts = [];
  let current = '';

  const lines =
    text.split('\n');

  for (
    const line of lines
  ) {
    const candidate =
      current
        ? `${current}\n${line}`
        : line;

    if (
      candidate.length >
        maxLength &&
      current
    ) {
      parts.push(
        current
      );

      current =
        line;
    } else {
      current =
        candidate;
    }
  }

  if (current) {
    parts.push(
      current
    );
  }

  return parts;
}

/* =========================================================
   ERROS
========================================================= */

async function replyError(
  interaction,
  error
) {
  const message =
    error?.message ||
    'Ocorreu um erro inesperado.';

  console.error(
    `[${interaction.commandName}]`,
    error
  );

  try {
    if (
      interaction.deferred ||
      interaction.replied
    ) {
      await interaction.editReply({
        content:
          `❌ ${message}`
      });
    } else {
      await interaction.reply({
        content:
          `❌ ${message}`,
        flags:
          MessageFlags.Ephemeral
      });
    }
  } catch (replyError) {
    console.error(
      'Não foi possível responder à interação:',
      replyError
    );
  }
}

/* =========================================================
   BOT ONLINE
========================================================= */

client.once(
  'clientReady',
  async connectedClient => {
    console.log(
      `🤖 Online como ${connectedClient.user.tag}`
    );

    for (
      const guild of connectedClient.guilds.cache.values()
    ) {
      try {
        await processExpiredSales(
          guild
        );
      } catch (error) {
        console.error(
          `Erro ao verificar vencimentos em ${guild.name}:`,
          error
        );
      }
    }

    setInterval(
      async () => {
        for (
          const guild of connectedClient.guilds.cache.values()
        ) {
          try {
            await processExpiredSales(
              guild
            );
          } catch (error) {
            console.error(
              `Erro na verificação automática em ${guild.name}:`,
              error
            );
          }
        }
      },
      EXPIRATION_CHECK_INTERVAL
    );
  }
);

/* =========================================================
   APAGA MENSAGENS MANUAIS DO PAINEL
========================================================= */

client.on(
  'messageCreate',
  async message => {
    try {
      if (
        message.author.bot ||
        !message.guild
      ) {
        return;
      }

      if (
        message.channel.name !==
        CHANNELS.painel
      ) {
        return;
      }

      await message.delete();
    } catch (error) {
      console.error(
        'Não foi possível apagar mensagem do painel:',
        error
      );
    }
  }
);

/* =========================================================
   INTERAÇÕES
========================================================= */

client.on(
  'interactionCreate',
  async interaction => {
    if (
      !interaction.isChatInputCommand() ||
      !interaction.guild
    ) {
      return;
    }

    try {
      await interaction.deferReply({
        flags:
          MessageFlags.Ephemeral
      });

      const guild =
        interaction.guild;

      const command =
        interaction.commandName;

      /* ===================================================
         /CONFIGURAR
      =================================================== */

      if (
        command ===
        'configurar'
      ) {
        await setup(
          guild
        );

        return interaction.editReply(
          '✅ Estrutura criada/atualizada com sucesso.'
        );
      }

      /* ===================================================
         RESTRINGE COMANDOS AO PAINEL
      =================================================== */

      const painelChannel =
        getChannel(
          guild,
          'painel'
        );

      if (
        !painelChannel ||
        interaction.channelId !==
        painelChannel.id
      ) {
        return interaction.editReply(
          '⚙️ Use os comandos no canal `⚙️・painel`.'
        );
      }

      /* ===================================================
         /VENDA
      =================================================== */

      if (
        command ===
        'venda'
      ) {
        const cliente =
          interaction.options.getString(
            'cliente'
          );

        const ferramenta =
          interaction.options.getString(
            'ferramenta'
          );

        const plano =
          interaction.options.getString(
            'plano'
          );

        const login =
          interaction.options.getString(
            'login'
          );

        const senha =
          interaction.options.getString(
            'senha'
          );

        const data =
          interaction.options.getString(
            'data'
          );

        const hora =
          interaction.options.getString(
            'hora'
          );

        validatePlan(
          ferramenta,
          plano
        );

        const registeredAt =
          buildRegisteredAt(
            data,
            hora
          );

        const vencimento =
          calculateExpiration(
            plano,
            registeredAt
          );

        const venda =
          await createRecord(
            guild,
            'vendas',
            'VENDA',
            [
              [
                '👤 CLIENTE',
                cliente
              ],
              [
                '🛠️ FERRAMENTA',
                ferramenta
              ],
              [
                '📦 PLANO',
                plano
              ],
              [
                '🔐 LOGIN',
                `\`${login}\``
              ],
              [
                '🔑 SENHA',
                `\`${senha}\``
              ],
              [
                '⏰ VENCIMENTO',
                dateTimeBR(
                  vencimento
                )
              ],
              [
                '📅 REGISTRADO EM',
                dateTimeBR(
                  registeredAt
                )
              ]
            ]
          );

        return interaction.editReply(
          [
            `✅ Venda registrada: **${venda.id}**`,
            `📅 Registrado em: **${dateTimeBR(registeredAt)}**`,
            `⏰ Vencimento: **${dateTimeBR(vencimento)}**`,
            '',
            '⏰ O registro será criado automaticamente em `⏰・vencimentos` quando a venda vencer.'
          ].join('\n')
        );
      }

      /* ===================================================
         /TROCA
      =================================================== */

      if (
        command ===
        'troca'
      ) {
        const cliente =
          interaction.options.getString(
            'cliente'
          );

        const ferramenta =
          interaction.options.getString(
            'ferramenta'
          );

        const motivo =
          interaction.options.getString(
            'motivo'
          );

        const observacao =
          interaction.options.getString(
            'observacao'
          ) || '-';

        const record =
          await createRecord(
            guild,
            'trocas',
            'TROCA',
            [
              [
                '👤 CLIENTE',
                cliente
              ],
              [
                '🛠️ FERRAMENTA',
                ferramenta
              ],
              [
                '📝 MOTIVO',
                motivo
              ],
              [
                '📄 OBSERVAÇÃO',
                observacao
              ],
              [
                '📅 REGISTRADO EM',
                dateTimeBR(
                  new Date()
                )
              ]
            ]
          );

        return interaction.editReply(
          `✅ Troca registrada: **${record.id}**`
        );
      }

      /* ===================================================
         /TROCA-SENHA
      =================================================== */

      if (
        command ===
        'troca-senha'
      ) {
        const vencimentoId =
          interaction.options.getString(
            'vencimento'
          );

        const novaSenha =
          interaction.options.getString(
            'nova_senha'
          );

        if (
          novaSenha.includes('\n') ||
          novaSenha.includes('\r')
        ) {
          throw new Error(
            'A nova senha não pode conter quebra de linha.'
          );
        }

        const result =
          await changeSinglePassword(
            guild,
            vencimentoId,
            novaSenha
          );

        return interaction.editReply(
          [
            '✅ Senha alterada com sucesso.',
            '',
            `🔖 Vencimento: **${result.id}**`,
            `👤 Cliente: **${result.client}**`,
            `🛠️ Ferramenta: **${result.tool}**`,
            `🔐 Login: \`${result.login}\``,
            '',
            'A senha foi alterada diretamente na venda.',
            'A conta não foi enviada para contas livres.'
          ].join('\n')
        );
      }

      /* ===================================================
         /TROCAR-SENHAS
      =================================================== */

      if (
        command ===
        'trocar-senhas'
      ) {
        const vencimentosInput =
          interaction.options.getString(
            'vencimentos'
          );

        const novaSenha =
          interaction.options.getString(
            'nova_senha'
          );

        const expirationIds =
          vencimentosInput
            .split(',')
            .map(
              id =>
                id.trim()
            )
            .filter(
              Boolean
            );

        if (
          !expirationIds.length
        ) {
          throw new Error(
            'Informe pelo menos um ID de vencimento.'
          );
        }

        if (
          novaSenha.includes('\n') ||
          novaSenha.includes('\r')
        ) {
          throw new Error(
            'A nova senha não pode conter quebra de linha.'
          );
        }

        const result =
          await changeExpiredPasswords(
            guild,
            expirationIds,
            novaSenha
          );

        if (
          !result.changed.length
        ) {
          return interaction.editReply(
            [
              '❌ Nenhuma conta foi processada.',
              '',
              ...result.errors.map(
                error =>
                  `• ${error}`
              )
            ].join('\n')
          );
        }

        const output = [
          `✅ ${result.changed.length} conta(s) processada(s).`,
          '',
          '🔄 Os registros foram marcados como:',
          '`🔄 STATUS: SENHA TROCADA`',
          '',
          '🆓 As novas credenciais foram separadas por ferramenta nos canais de contas livres.'
        ];

        if (
          result.errors.length
        ) {
          output.push(
            '',
            '⚠️ Não processadas:',
            ...result.errors.map(
              error =>
                `• ${error}`
            )
          );
        }

        return interaction.editReply(
          output.join('\n')
        );
      }

      /* ===================================================
         /VENCIDAS
      =================================================== */

      if (
        command ===
        'vencidas'
      ) {
        const grouped =
          await getExpiredAccounts(
            guild
          );

        const sections = [];

        /*
         * UNLOCK TOOL
         */

        if (
          grouped['Unlock Tool']?.length
        ) {
          sections.push(
            [
              '🔓 UNLOCK TOOL',
              ...grouped['Unlock Tool'].map(
                account =>
                  `${account.login}:${account.password}`
              )
            ].join('\n')
          );
        }

        /*
         * TSM TOOL
         */

        if (
          grouped['TSM Tool']?.length
        ) {
          sections.push(
            [
              '🛠️ TSM TOOL',
              ...grouped['TSM Tool'].map(
                account =>
                  `${account.login}:${account.password}`
              )
            ].join('\n')
          );
        }

        /*
         * AMT TOOL
         */

        if (
          grouped['AMT Tool']?.length
        ) {
          sections.push(
            [
              '⚙️ AMT TOOL',
              ...grouped['AMT Tool'].map(
                account =>
                  `${account.login}:${account.password}`
              )
            ].join('\n')
          );
        }

        if (!sections.length) {
          return interaction.editReply(
            '✅ Nenhuma venda vencida pendente de troca de senha.'
          );
        }

        /*
         * Uma conta por linha.
         * Uma linha em branco somente entre ferramentas.
         */

        const text =
          sections.join(
            '\n\n'
          );

        const parts =
          splitText(
            text,
            1900
          );

        await interaction.editReply({
          content:
            parts[0]
        });

        for (
          let i = 1;
          i < parts.length;
          i++
        ) {
          await interaction.followUp({
            content:
              parts[i],
            flags:
              MessageFlags.Ephemeral
          });
        }

        return;
      }

      /* ===================================================
         /RENOVAR
      =================================================== */

      if (
        command ===
        'renovar'
      ) {
        const cliente =
          interaction.options.getString(
            'cliente'
          );

        const ferramenta =
          interaction.options.getString(
            'ferramenta'
          );

        const plano =
          interaction.options.getString(
            'plano'
          );

        validatePlan(
          ferramenta,
          plano
        );

        const current =
          await findCurrentSale(
            guild,
            cliente,
            ferramenta
          );

        if (!current) {
          throw new Error(
            'Nenhuma venda ativa encontrada para esse cliente e ferramenta.'
          );
        }

        const registeredAt =
          new Date();

        const novoVencimento =
          calculateExpiration(
            plano,
            current.expiration
          );

        const renovacao =
          await createRecord(
            guild,
            'renovacoes',
            'RENOVAÇÃO',
            [
              [
                '👤 CLIENTE',
                cliente
              ],
              [
                '🛠️ FERRAMENTA',
                ferramenta
              ],
              [
                '📦 NOVO PLANO',
                plano
              ],
              [
                '⏰ NOVO VENCIMENTO',
                dateTimeBR(
                  novoVencimento
                )
              ],
              [
                '📅 REGISTRADO EM',
                dateTimeBR(
                  registeredAt
                )
              ],
              [
                '🔗 VENDA',
                current.message.url
              ]
            ]
          );

        let updatedSale =
          current.message.content;

        updatedSale =
          updatedSale.replace(
            /📦 PLANO: .+/,
            `📦 PLANO: ${plano}`
          );

        updatedSale =
          updatedSale.replace(
            /⏰ VENCIMENTO: .+/,
            `⏰ VENCIMENTO: ${dateTimeBR(novoVencimento)}`
          );

        await current.message.edit(
          updatedSale
        );

        return interaction.editReply(
          [
            `✅ Renovação registrada: **${renovacao.id}**`,
            `⏰ Novo vencimento: **${dateTimeBR(novoVencimento)}**`,
            `🔗 Venda: ${current.message.url}`
          ].join('\n')
        );
      }

      /* ===================================================
         /VER
      =================================================== */

      if (
        command ===
        'ver'
      ) {
        const type =
          interaction.options.getString(
            'tipo'
          );

        const id =
          interaction.options.getString(
            'id'
          );

        if (id) {
          const message =
            await findRecord(
              guild,
              type,
              id
            );

          return interaction.editReply(
            message
              ? message.content
              : `❌ Registro **${id.toUpperCase()}** não encontrado em ${typeLabel(type)}.`
          );
        }

        const channel =
          getChannel(
            guild,
            type
          );

        const rows =
          (
            await fetchAllMessages(
              channel
            )
          ).filter(
            message =>
              message.content.includes(
                '🔖 ID:'
              )
          );

        const message =
          rows[0];

        return interaction.editReply(
          message
            ? message.content
            : `❌ Nenhum registro encontrado em ${typeLabel(type)}.`
        );
      }

      /* ===================================================
         /BUSCAR
      =================================================== */

      if (
        command ===
        'buscar'
      ) {
        const termo =
          interaction.options
            .getString(
              'termo'
            )
            .toLowerCase();

        const type =
          interaction.options.getString(
            'tipo'
          ) || 'tudo';

        const types =
          type === 'tudo'
            ? Object.keys(PREFIX)
            : [type];

        const found = [];

        for (
          const currentType of types
        ) {
          const channel =
            getChannel(
              guild,
              currentType
            );

          if (!channel) {
            continue;
          }

          const messages =
            await fetchAllMessages(
              channel
            );

          for (
            const message of messages
          ) {
            if (
              message.content
                .toLowerCase()
                .includes(
                  termo
                )
            ) {
              found.push({
                type:
                  currentType,
                content:
                  message.content
              });
            }

            if (
              found.length >= 10
            ) {
              break;
            }
          }

          if (
            found.length >= 10
          ) {
            break;
          }
        }

        if (!found.length) {
          return interaction.editReply(
            `❌ Nenhum registro encontrado para **${interaction.options.getString('termo')}**.`
          );
        }

        let output =
          found
            .map(
              item =>
                `**${typeLabel(item.type)}**\n${item.content}`
            )
            .join(
              '\n\n'
            );

        if (
          output.length > 3900
        ) {
          output =
            output.slice(
              0,
              3890
            ) +
            '\n…';
        }

        return interaction.editReply(
          output
        );
      }

      /* ===================================================
         /LISTAR
      =================================================== */

      if (
        command ===
        'listar'
      ) {
        const type =
          interaction.options.getString(
            'tipo'
          );

        const quantity =
          interaction.options.getInteger(
            'quantidade'
          ) || 10;

        const channel =
          getChannel(
            guild,
            type
          );

        const rows =
          (
            await fetchAllMessages(
              channel
            )
          )
            .filter(
              message =>
                message.content.includes(
                  '🔖 ID:'
                )
            )
            .slice(
              0,
              quantity
            );

        if (!rows.length) {
          return interaction.editReply(
            `❌ Nenhum registro em ${typeLabel(type)}.`
          );
        }

        let output =
          rows
            .map(
              message =>
                message.content
                  .split('\n')
                  .slice(
                    0,
                    7
                  )
                  .join('\n')
            )
            .join(
              '\n\n'
            );

        if (
          output.length > 3900
        ) {
          output =
            output.slice(
              0,
              3890
            ) +
            '\n…';
        }

        return interaction.editReply(
          output
        );
      }

      /* ===================================================
         /VENCIMENTOS-PROXIMOS
      =================================================== */

      if (
        command ===
        'vencimentos-proximos'
      ) {
        const days =
          interaction.options.getInteger(
            'dias'
          ) || 30;

        const now =
          new Date();

        const limit =
          new Date(
            now.getTime() +
            days *
              24 *
              60 *
              60 *
              1000
          );

        const vendasChannel =
          getChannel(
            guild,
            'vendas'
          );

        const rows = [];

        if (vendasChannel) {
          const messages =
            await fetchAllMessages(
              vendasChannel
            );

          for (
            const message of messages
          ) {
            const expiration =
              extractExpiration(
                message.content
              );

            if (!expiration) {
              continue;
            }

            if (
              expiration < now ||
              expiration > limit
            ) {
              continue;
            }

            const id =
              extractSaleId(
                message.content
              );

            const clientName =
              extractClient(
                message.content
              );

            if (!id) {
              continue;
            }

            rows.push({
              id,
              client:
                clientName || '-',
              date:
                dateTimeBR(
                  expiration
                ),
              expiration
            });
          }
        }

        rows.sort(
          (a, b) =>
            a.expiration.getTime() -
            b.expiration.getTime()
        );

        if (!rows.length) {
          return interaction.editReply(
            `✅ Nenhum vencimento nos próximos ${days} dias.`
          );
        }

        let output =
          [
            `⏰ **Vencimentos próximos (${days} dias)**`,
            '',
            ...rows.map(
              row =>
                `🔖 ${row.id} — ${row.client} — ${row.date}`
            )
          ].join('\n');

        if (
          output.length > 3900
        ) {
          output =
            output.slice(
              0,
              3890
            ) +
            '\n…';
        }

        return interaction.editReply(
          output
        );
      }

      /* ===================================================
         /PAINEL
      =================================================== */

      if (
        command ===
        'painel'
      ) {
        const counts = {};

        for (
          const type of Object.keys(
            PREFIX
          )
        ) {
          const channel =
            getChannel(
              guild,
              type
            );

          counts[type] =
            channel
              ? (
                  await fetchAllMessages(
                    channel
                  )
                ).filter(
                  message =>
                    message.content.includes(
                      '🔖 ID:'
                    )
                ).length
              : 0;
        }

        const total =
          Object.values(
            counts
          ).reduce(
            (
              sum,
              value
            ) =>
              sum + value,
            0
          );

        return interaction.editReply(
          [
            '📊 **PAINEL UNLOCK FÁCIL**',
            '',
            `💰 Vendas: ${counts.vendas}`,
            `⏰ Vencimentos: ${counts.vencimentos}`,
            `🔄 Trocas: ${counts.trocas}`,
            `♻️ Renovações: ${counts.renovacoes}`,
            '',
            `📦 Total de registros: ${total}`
          ].join('\n')
        );
      }

    } catch (error) {
      await replyError(
        interaction,
        error
      );
    }
  }
);

/* =========================================================
   ERROS DO CLIENTE
========================================================= */

client.on(
  'error',
  error =>
    console.error(
      'Discord client error:',
      error
    )
);

process.on(
  'unhandledRejection',
  error =>
    console.error(
      'Unhandled promise rejection:',
      error
    )
);

process.on(
  'uncaughtException',
  error =>
    console.error(
      'Uncaught exception:',
      error
    )
);

/* =========================================================
   LOGIN
========================================================= */

if (
  !process.env.DISCORD_TOKEN
) {
  console.error(
    '❌ DISCORD_TOKEN não encontrado no arquivo .env.'
  );

  process.exit(1);
}

client.login(
  process.env.DISCORD_TOKEN
);
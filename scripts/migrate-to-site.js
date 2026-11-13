'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const { Store } = require('../src/store');
const { normalizeEncryptionKey } = require('../src/crypto');
const { ensureDataChannel } = require('../src/transport');

const TOOL_NAME_TO_ID = {
  'Unlock Tool': 'unlocktool',
  'Borneo Schematics': 'borneo',
  'TSM Tool': 'tsmtool',
  'AMT Tool': 'amttool',
  'TFM Tool': 'tfmtool',
};

const PLAN_NAME_TO_SUFFIX = {
  '12 horas': '12h',
  '1 mês': '1m',
  '3 meses': '3m',
  '6 meses': '6m',
  '3 dias': '3d',
  'Créditos': 'creditos',
  'Curso': 'curso',
};

function siteEncrypt(text, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function credFingerprint(toolId, login) {
  return crypto.createHash('sha256')
    .update(String(toolId) + ':' + String(login || '').trim().toLowerCase())
    .digest('hex');
}

function mapPlanId(toolName, planName) {
  const toolId = TOOL_NAME_TO_ID[toolName] || toolName.toLowerCase().replace(/\s+/g, '');
  const suffix = PLAN_NAME_TO_SUFFIX[planName] || planName.toLowerCase().replace(/\s+/g, '-');
  return `${toolId}-${suffix}`;
}

async function main() {
  const env = process.env;
  const dbUrl = env.DATABASE_URL;
  const siteKey = env.SITE_ENCRYPTION_KEY;

  if (!dbUrl) { console.error('DATABASE_URL não configurada.'); process.exit(1); }
  if (!siteKey || !/^[a-fA-F0-9]{64}$/.test(siteKey)) {
    console.error('SITE_ENCRYPTION_KEY não configurada (precisa ser a DATA_ENCRYPTION_KEY do site, 64 hex chars).');
    process.exit(1);
  }

  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });

  console.log('Conectando ao Discord para carregar dados do bot...');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });

  normalizeEncryptionKey(env.ENCRYPTION_KEY);

  const data = await new Promise((resolve, reject) => {
    client.once('clientReady', async connected => {
      try {
        const guild = connected.guilds.cache.get(env.GUILD_ID) || await connected.guilds.fetch(env.GUILD_ID);
        const channel = await ensureDataChannel(guild, {
          client: connected,
          channelId: env.DISCORD_DATA_CHANNEL_ID,
          adminRoleId: env.ADMIN_ROLE_ID,
          sellerRoleId: env.SELLER_ROLE_ID,
        });
        const store = new Store({
          channel, guildId: guild.id, botId: connected.user.id,
          encryptionKey: env.ENCRYPTION_KEY,
        });

        console.log('Carregando store do Discord (pode demorar)...');
        await store.load();

        const vendas = await store.listRecords(guild.id, 'vendas');
        const renovacoes = await store.listRecords(guild.id, 'renovacoes');
        const trocas = await store.listRecords(guild.id, 'trocas');
        const vencimentos = await store.listRecords(guild.id, 'vencimentos');
        const adExpenses = await store.listAdExpenses(guild.id);
        const accounts = await store.listAccounts(guild.id);

        console.log(`Dados carregados: ${vendas.length} vendas, ${renovacoes.length} renovações, ${trocas.length} trocas, ${vencimentos.length} vencimentos, ${adExpenses.length} gastos, ${accounts.length} contas`);

        resolve({ vendas, renovacoes, trocas, vencimentos, adExpenses, accounts });
      } catch (error) {
        reject(error);
      } finally {
        client.destroy();
      }
    });
    client.login(env.DISCORD_TOKEN);
  });

  // --- BACKUP ---
  console.log('\nFazendo backup das tabelas antes de limpar...');
  const ordersBk = await pool.query('SELECT count(*) FROM orders');
  const stockBk = await pool.query('SELECT count(*) FROM stock');
  console.log(`  orders: ${ordersBk.rows[0].count} registros, stock: ${stockBk.rows[0].count} registros`);

  // --- LIMPAR ---
  console.log('Limpando orders e stock...');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM stock');
  await pool.query('DELETE FROM discord_sync');
  console.log('Tabelas limpas.');

  // --- INSERIR VENDAS no discord_sync ---
  console.log('\nInserindo vendas no discord_sync...');
  let syncCount = 0;
  for (const sale of data.vendas) {
    const eventId = `sale:${sale.id}:${sale.registeredAt}`;
    await pool.query(
      `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      ['sale', eventId, sale.id, sale.tool, sale.client,
       sale.currentPlan || sale.plan, sale.priceCents || 0, sale.discountCents || 0,
       sale.registeredAt, JSON.stringify({ status: sale.status, expiresAt: sale.expiresAt, credits: sale.credits, oneTime: sale.oneTime, accountId: sale.accountId })]
    );
    syncCount++;
  }
  console.log(`  ${syncCount} vendas inseridas.`);

  // --- INSERIR RENOVAÇÕES ---
  console.log('Inserindo renovações...');
  let renCount = 0;
  for (const ren of data.renovacoes) {
    const eventId = `renewal:${ren.id}:${ren.registeredAt}`;
    const sale = data.vendas.find(v => v.id === ren.saleId);
    await pool.query(
      `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      ['renewal', eventId, ren.id, sale?.tool || ren.tool, sale?.client || ren.client,
       ren.plan, ren.priceCents || 0, ren.discountCents || 0,
       ren.registeredAt, JSON.stringify({ saleId: ren.saleId, expiresAt: ren.expiresAt })]
    );
    renCount++;
  }
  console.log(`  ${renCount} renovações inseridas.`);

  // --- INSERIR TROCAS ---
  console.log('Inserindo trocas...');
  let tradeCount = 0;
  for (const trade of data.trocas) {
    const eventId = `trade:${trade.id}:${trade.registeredAt}`;
    const sale = data.vendas.find(v => v.id === trade.saleId);
    await pool.query(
      `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      ['trade', eventId, trade.id, sale?.tool || trade.tool, sale?.client || trade.client,
       trade.newPlan || trade.previousPlan, 0, 0,
       trade.registeredAt, JSON.stringify({ saleId: trade.saleId, reason: trade.reason, previousPlan: trade.previousPlan, newPlan: trade.newPlan })]
    );
    tradeCount++;
  }
  console.log(`  ${tradeCount} trocas inseridas.`);

  // --- INSERIR VENCIMENTOS ---
  console.log('Inserindo vencimentos...');
  let expCount = 0;
  for (const exp of data.vencimentos) {
    const eventId = `expiration:${exp.id}:${exp.registeredAt}`;
    await pool.query(
      `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      ['expiration', eventId, exp.id, exp.tool, exp.client,
       null, 0, 0,
       exp.registeredAt, JSON.stringify({ saleId: exp.saleId, expiresAt: exp.expiresAt, status: exp.status })]
    );
    expCount++;
  }
  console.log(`  ${expCount} vencimentos inseridos.`);

  // --- INSERIR GASTOS COM ANÚNCIO ---
  console.log('Inserindo gastos com anúncio...');
  let adCount = 0;
  for (const ad of data.adExpenses) {
    const eventId = `ad_expense:${ad.id}:${ad.createdAt || ad.date}`;
    await pool.query(
      `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      ['ad_expense', eventId, ad.id, null, null,
       null, ad.amountCents || 0, 0,
       ad.createdAt || ad.date || new Date().toISOString(),
       JSON.stringify({ date: ad.date, description: ad.description })]
    );
    adCount++;
  }
  console.log(`  ${adCount} gastos inseridos.`);

  // --- INSERIR CONTAS no stock ---
  console.log('\nInserindo contas do Discord no stock...');
  let acctCount = 0;
  let acctSkipped = 0;
  for (const acct of data.accounts) {
    const toolId = TOOL_NAME_TO_ID[acct.tool];
    if (!toolId) { console.log(`  Ignorando conta ${acct.id}: ferramenta "${acct.tool}" desconhecida.`); acctSkipped++; continue; }

    const creds = JSON.stringify({
      login: acct.login || '',
      password: acct.password || '',
      instruction: '',
    });
    const encrypted = siteEncrypt(creds, siteKey);
    const fp = credFingerprint(toolId, acct.login);

    const siteStatus = acct.status === 'available' ? 'available' : 'sold';
    const planId = toolId + '-1m';

    try {
      await pool.query(
        `INSERT INTO stock (plan_id, tool_id, encrypted_credentials, status, cred_fp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [planId, toolId, encrypted, siteStatus, fp]
      );
      acctCount++;
    } catch (err) {
      console.log(`  Erro ao inserir conta ${acct.id} (${acct.login}): ${err.message}`);
      acctSkipped++;
    }
  }
  console.log(`  ${acctCount} contas inseridas, ${acctSkipped} ignoradas.`);

  // --- RESUMO ---
  const finalSync = await pool.query('SELECT count(*) FROM discord_sync');
  const finalStock = await pool.query('SELECT count(*) FROM stock');
  console.log(`\n✅ Migração concluída!`);
  console.log(`   discord_sync: ${finalSync.rows[0].count} registros`);
  console.log(`   stock: ${finalStock.rows[0].count} contas`);
  console.log(`   orders: 0 (limpo — vendas do Discord ficam na aba Discord)`);

  await pool.end();
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });

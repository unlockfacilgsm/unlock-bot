'use strict';

const { dateKey, formatBR } = require('./dates');
const { money } = require('./catalog');

function summarize(records, now = new Date()) {
  const transactions = records.filter(record => ['vendas', 'renovacoes'].includes(record.type));
  const today = dateKey(now);
  const yesterday = dateKey(new Date(now.getTime() - 86_400_000));
  const [year, month] = today.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 15));
  const previousMonth = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
  const totals = { today: { count: 0, value: 0 }, yesterday: { count: 0, value: 0 }, month: { count: 0, value: 0 }, previousMonth: { count: 0, value: 0 }, tools: {}, plans: {}, days: {}, estimated: 0, unknown: 0 };
  for (const record of transactions) {
    if (!Number.isFinite(Date.parse(record.registeredAt))) continue;
    const day = dateKey(record.registeredAt);
    const value = Number.isSafeInteger(record.priceCents) ? record.priceCents : 0;
    if (record.priceEstimated) totals.estimated++;
    if (record.priceUnknown) totals.unknown++;
    const buckets = [totals.days[day] ||= { count: 0, value: 0 }, totals.tools[record.tool] ||= { count: 0, value: 0 }, totals.plans[record.plan] ||= { count: 0, value: 0 }];
    if (day === today) buckets.push(totals.today);
    if (day === yesterday) buckets.push(totals.yesterday);
    if (day.slice(0, 7) === today.slice(0, 7)) buckets.push(totals.month);
    if (day.slice(0, 7) === previousMonth) buckets.push(totals.previousMonth);
    for (const bucket of buckets) { bucket.count++; bucket.value += value; }
  }
  return totals;
}

function dashboardText(records, accounts, now = new Date(), adExpenses = []) {
  const totals = summarize(records, now);
  const lines = ['📊 **PAINEL UNLOCK FÁCIL**', 'Receitas de vendas e renovações, pelo valor registrado.', '',
    `Hoje: ${totals.today.count} operação(ões) — **${money(totals.today.value)}**`,
    `Ontem: ${totals.yesterday.count} — ${money(totals.yesterday.value)}`,
    `Este mês: ${totals.month.count} — **${money(totals.month.value)}**`,
    `Mês anterior: ${totals.previousMonth.count} — ${money(totals.previousMonth.value)}`, '', '📆 **Últimos 7 dias**'];
  for (let day = 6; day >= 0; day--) {
    const date = new Date(now.getTime() - day * 86_400_000);
    const bucket = totals.days[dateKey(date)] || { count: 0, value: 0 };
    lines.push(`${formatBR(date).split(' ')[0]}: ${bucket.count} — ${money(bucket.value)}`);
  }
  const sold = {};
  for (const record of records.filter(record => ['vendas', 'renovacoes'].includes(record.type))) {
    const tool = record.tool || 'Ferramenta desconhecida';
    const plan = record.plan || 'Plano desconhecido';
    sold[tool] ||= {};
    sold[tool][plan] = (sold[tool][plan] || 0) + 1;
  }
  lines.push('', '🛠️ **Por ferramenta**');
  for (const [tool, stats] of Object.entries(totals.tools)) {
    lines.push(`**${tool}**: ${stats.count} operação(ões) — ${money(stats.value)}`);
    for (const [plan, count] of Object.entries(sold[tool] || {}).sort(([a], [b]) => a.localeCompare(b, 'pt-BR'))) lines.push(`  • ${plan}: **${count} operação(ões)**`);
  }
  for (const [tool, plans] of Object.entries(sold)) {
    if (Object.hasOwn(totals.tools, tool)) continue;
    lines.push(`**${tool}**`);
    for (const [plan, count] of Object.entries(plans)) lines.push(`  • ${plan}: **${count} operação(ões)**`);
  }
  if (!Object.keys(sold).length) lines.push('Nenhuma venda registrada.');
  const todayKey = dateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const spendToday = adExpenses.filter(item => item.date === todayKey).reduce((sum, item) => sum + item.amountCents, 0);
  const spendMonth = adExpenses.filter(item => item.date?.slice(0, 7) === monthKey).reduce((sum, item) => sum + item.amountCents, 0);
  const spendTotal = adExpenses.reduce((sum, item) => sum + item.amountCents, 0);
  lines.push('', '📣 **Gastos com anúncios**', `Hoje: **${money(spendToday)}**`, `Este mês: **${money(spendMonth)}**`, `Total registrado: **${money(spendTotal)}**`, `Resultado do mês após anúncios: **${money(totals.month.value - spendMonth)}**`);
  lines.push('', `Contas: ${accounts.filter(a => a.status === 'available' && !a.pendingDelivery).length} disponíveis; ${accounts.filter(a => a.status === 'occupied').length} ocupadas; ${accounts.filter(a => a.pendingDelivery).length} aguardando entrega.`);
  if (totals.estimated) lines.push(`⚠️ ${totals.estimated} valor(es) do histórico foram estimados durante a migração.`);
  if (totals.unknown) lines.push(`⚠️ ${totals.unknown} operação(ões) antigas sem preço conhecido não foram incluídas no valor total.`);
  return lines.join('\n');
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(records) {
  const fields = ['id', 'type', 'client', 'tool', 'plan', 'login', 'status', 'priceCents', 'discountCents', 'priceEstimated', 'priceUnknown', 'registeredAt', 'expiresAt', 'actorId'];
  return Buffer.from('\uFEFF' + [fields.map(csvCell).join(';'), ...records.map(record => fields.map(field => csvCell(record[field])).join(';'))].join('\r\n'), 'utf8');
}

module.exports = { summarize, dashboardText, exportCsv };

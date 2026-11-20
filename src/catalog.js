'use strict';

const CREDIT_PLAN = 'Créditos';
const CREDIT = Object.freeze({ priceCents: 500, perCredit: true });
const COURSE_PLAN = 'Curso';

const FALLBACK_TOOLS = Object.freeze({
  'Unlock Tool': { emoji: '🔓', channelKey: 'unlockTool', channelName: '🆓・unlock-tool', plans: {
    '24 horas': { priceCents: 1000, hours: 24 }, '1 mês': { priceCents: 3000, months: 1 }, '3 meses': { priceCents: 6000, months: 3 }, '6 meses': { priceCents: 9000, months: 6 },
    [CREDIT_PLAN]: CREDIT, [COURSE_PLAN]: { priceCents: 4500, oneTime: true }
  } },
  'Borneo Schematics': { emoji: '🔧', channelKey: 'borneoSchematics', channelName: '🆓・borneo-schematics', hwids: 1, plans: {
    '3 dias': { priceCents: 3000, days: 3 }, '1 mês': { priceCents: 5000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } },
  'TSM Tool': { emoji: '🛠️', channelKey: 'tsmTool', channelName: '🆓・tsm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, '3 meses': { priceCents: 6000, months: 3 }, [CREDIT_PLAN]: CREDIT
  } },
  'AMT Tool': { emoji: '⚙️', channelKey: 'amtTool', channelName: '🆓・amt-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } },
  'TFM Tool': { emoji: '🔩', channelKey: 'tfmTool', channelName: '🆓・tfm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } }
});

// Planos que saíram do catálogo mas ainda existem em vendas antigas (renovar, trocar conta,
// editar, vencimento). Continuam VÁLIDOS para esses registros, mas não aparecem no /vender,
// nas sugestões de plano nem no catálogo publicado.
// 16/11/2026: Unlock Tool 12 horas → 24 horas pelo mesmo valor.
const LEGACY_PLANS = Object.freeze({
  'Unlock Tool': { '12 horas': { priceCents: 1000, hours: 12, legacy: true } },
});

let _tools = FALLBACK_TOOLS;

function applyDynamic(dbTools) {
  if (!dbTools || !Object.keys(dbTools).length) return;
  const merged = {};
  for (const [name, fallback] of Object.entries(FALLBACK_TOOLS)) {
    const db = dbTools[name];
    if (!db) { merged[name] = fallback; continue; }
    const plans = { ...db.plans };
    // Créditos and Curso are bot-only plans, not in catalog_plans — preserve them.
    if (fallback.plans[CREDIT_PLAN]) plans[CREDIT_PLAN] = fallback.plans[CREDIT_PLAN];
    if (fallback.plans[COURSE_PLAN]) plans[COURSE_PLAN] = fallback.plans[COURSE_PLAN];
    merged[name] = { ...fallback, ...db, plans };
  }
  // Include any new tools from DB that aren't in fallback (future-proof).
  for (const [name, db] of Object.entries(dbTools)) {
    if (!merged[name]) merged[name] = db;
  }
  _tools = Object.freeze(merged);
}

function money(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function getPlan(tool, plan) {
  if (!Object.hasOwn(_tools, tool)) throw new Error('Ferramenta inválida.');
  if (Object.hasOwn(_tools[tool].plans, plan)) return _tools[tool].plans[plan];
  if (LEGACY_PLANS[tool] && Object.hasOwn(LEGACY_PLANS[tool], plan)) return LEGACY_PLANS[tool][plan];
  throw new Error(`O plano ${plan} não está disponível para ${tool}.`);
}

function definitionOf(tool, plan) {
  if (!Object.hasOwn(_tools, tool)) return null;
  if (Object.hasOwn(_tools[tool].plans, plan)) return _tools[tool].plans[plan];
  return LEGACY_PLANS[tool] && Object.hasOwn(LEGACY_PLANS[tool], plan) ? LEGACY_PLANS[tool][plan] : null;
}

function isCreditPlan(tool, plan) {
  return Boolean(definitionOf(tool, plan)?.perCredit);
}

function isOneTimePlan(tool, plan) {
  const definition = definitionOf(tool, plan);
  return Boolean(definition?.perCredit || definition?.oneTime);
}

function planPrice(definition) {
  return `${money(definition.priceCents)}${definition.perCredit ? ' por crédito' : ''}`;
}

function toolChoices() {
  return Object.keys(_tools).map(tool => ({ name: `${_tools[tool].emoji} ${tool}`, value: tool }));
}

function planChoices(tool, query = '', { oneTime = true } = {}) {
  if (!Object.hasOwn(_tools, tool)) return [];
  const normalized = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ\s]/g, '');
  const search = normalized(query);
  return Object.entries(_tools[tool].plans)
    .filter(([plan, definition]) => (oneTime || !(definition.perCredit || definition.oneTime)) && normalized(plan).includes(search))
    .map(([plan, definition]) => ({ name: `${plan} — ${planPrice(definition)}`, value: plan }));
}

Object.defineProperty(module.exports, 'TOOLS', { get: () => _tools, enumerable: true });
module.exports.CREDIT_PLAN = CREDIT_PLAN;
module.exports.COURSE_PLAN = COURSE_PLAN;
module.exports.money = money;
module.exports.getPlan = getPlan;
module.exports.validatePlan = getPlan;
module.exports.isCreditPlan = isCreditPlan;
module.exports.isOneTimePlan = isOneTimePlan;
module.exports.planPrice = planPrice;
module.exports.toolChoices = toolChoices;
module.exports.planChoices = planChoices;
module.exports.applyDynamic = applyDynamic;
module.exports.FALLBACK_TOOLS = FALLBACK_TOOLS;
module.exports.LEGACY_PLANS = LEGACY_PLANS;

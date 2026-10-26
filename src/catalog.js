'use strict';

const CREDIT_PLAN = 'Créditos';
// Créditos não reservam conta nem vencem: o preço é por unidade.
const CREDIT = Object.freeze({ priceCents: 500, perCredit: true });

const TOOLS = Object.freeze({
  'Unlock Tool': { emoji: '🔓', channelKey: 'unlockTool', channelName: '🆓・unlock-tool', plans: {
    '12 horas': { priceCents: 1000, hours: 12 }, '1 mês': { priceCents: 3000, months: 1 }, '3 meses': { priceCents: 6000, months: 3 }, '6 meses': { priceCents: 9000, months: 6 },
    [CREDIT_PLAN]: CREDIT
  } },
  'Borneo Schematics': { emoji: '🔧', channelKey: 'borneoSchematics', channelName: '🆓・borneo-schematics', hwids: 1, plans: {
    '3 dias': { priceCents: 3000, days: 3 }, '1 mês': { priceCents: 5000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } },
  'TSM Tool': { emoji: '🛠️', channelKey: 'tsmTool', channelName: '🆓・tsm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } },
  'AMT Tool': { emoji: '⚙️', channelKey: 'amtTool', channelName: '🆓・amt-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } },
  'TFM Tool': { emoji: '🔩', channelKey: 'tfmTool', channelName: '🆓・tfm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 4000, months: 1 }, [CREDIT_PLAN]: CREDIT
  } }
});

function money(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function getPlan(tool, plan) {
  if (!Object.hasOwn(TOOLS, tool)) throw new Error('Ferramenta inválida.');
  if (!Object.hasOwn(TOOLS[tool].plans, plan)) throw new Error(`O plano ${plan} não está disponível para ${tool}.`);
  return TOOLS[tool].plans[plan];
}

function isCreditPlan(tool, plan) {
  return Boolean(Object.hasOwn(TOOLS, tool) && Object.hasOwn(TOOLS[tool].plans, plan) && TOOLS[tool].plans[plan].perCredit);
}

function planPrice(definition) {
  return `${money(definition.priceCents)}${definition.perCredit ? ' por crédito' : ''}`;
}

function toolChoices() {
  return Object.keys(TOOLS).map(tool => ({ name: `${TOOLS[tool].emoji} ${tool}`, value: tool }));
}

function planChoices(tool, query = '', { credits = true } = {}) {
  if (!Object.hasOwn(TOOLS, tool)) return [];
  const normalized = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f\s]/g, '');
  const search = normalized(query);
  return Object.entries(TOOLS[tool].plans)
    .filter(([plan, definition]) => (credits || !definition.perCredit) && normalized(plan).includes(search))
    .map(([plan, definition]) => ({ name: `${plan} — ${planPrice(definition)}`, value: plan }));
}

module.exports = { TOOLS, CREDIT_PLAN, money, getPlan, validatePlan: getPlan, isCreditPlan, planPrice, toolChoices, planChoices };

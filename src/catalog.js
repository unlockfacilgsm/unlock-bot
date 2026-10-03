'use strict';

const TOOLS = Object.freeze({
  'Unlock Tool': { emoji: '🔓', channelKey: 'unlockTool', channelName: '🆓・unlock-tool', plans: {
    '12 horas': { priceCents: 1000, hours: 12 }, '1 mês': { priceCents: 3000, months: 1 }, '3 meses': { priceCents: 5500, months: 3 }, '12 meses': { priceCents: 11000, months: 12 }
  } },
  'Borneo Schematics': { emoji: '🔧', channelKey: 'borneoSchematics', channelName: '🆓・borneo-schematics', plans: {
    '3 dias': { priceCents: 2000, days: 3 }, '1 mês': { priceCents: 3500, months: 1 }, '3 meses': { priceCents: 5500, months: 3 }, '12 meses': { priceCents: 11000, months: 12 }
  } },
  'TSM Tool': { emoji: '🛠️', channelKey: 'tsmTool', channelName: '🆓・tsm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 3000, months: 1 }, '3 meses': { priceCents: 5500, months: 3 }
  } },
  'AMT Tool': { emoji: '⚙️', channelKey: 'amtTool', channelName: '🆓・amt-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '1 mês': { priceCents: 3000, months: 1 }, '3 meses': { priceCents: 5500, months: 3 }
  } },
  'TFM Tool': { emoji: '🔩', channelKey: 'tfmTool', channelName: '🆓・tfm-tool', plans: {
    '12 horas': { priceCents: 2000, hours: 12 }, '3 meses': { priceCents: 5500, months: 3 }
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

function toolChoices() {
  return Object.keys(TOOLS).map(tool => ({ name: `${TOOLS[tool].emoji} ${tool}`, value: tool }));
}

function planChoices(tool, query = '') {
  if (!Object.hasOwn(TOOLS, tool)) return [];
  const normalized = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f\s]/g, '');
  const search = normalized(query);
  return Object.entries(TOOLS[tool].plans)
    .filter(([plan]) => normalized(plan).includes(search))
    .map(([plan, definition]) => ({ name: `${plan} — ${money(definition.priceCents)}`, value: plan }));
}

module.exports = { TOOLS, money, getPlan, validatePlan: getPlan, toolChoices, planChoices };

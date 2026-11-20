'use strict';

const TOOL_ID_TO_NAME = {
  unlocktool: 'Unlock Tool',
  borneo: 'Borneo Schematics',
  tsmtool: 'TSM Tool',
  amttool: 'AMT Tool',
  tfmtool: 'TFM Tool',
};

const TOOL_META = {
  'Unlock Tool': { emoji: '🔓', channelKey: 'unlockTool', channelName: '🆓・unlock-tool' },
  'Borneo Schematics': { emoji: '🔧', channelKey: 'borneoSchematics', channelName: '🆓・borneo-schematics', hwids: 1 },
  'TSM Tool': { emoji: '🛠️', channelKey: 'tsmTool', channelName: '🆓・tsm-tool' },
  'AMT Tool': { emoji: '⚙️', channelKey: 'amtTool', channelName: '🆓・amt-tool' },
  'TFM Tool': { emoji: '🔩', channelKey: 'tfmTool', channelName: '🆓・tfm-tool' },
};

function hoursToPlanDef(hours, priceCents) {
  if (hours === null || hours === undefined) return { priceCents };
  if (hours <= 48) return { priceCents, hours };
  if (hours <= 72) return { priceCents, days: Math.round(hours / 24) };
  return { priceCents, months: Math.round(hours / 720) };
}

function buildTools(rows) {
  const tools = {};
  for (const row of rows) {
    const toolName = TOOL_ID_TO_NAME[row.tool_id];
    if (!toolName) continue;
    const meta = TOOL_META[toolName];
    if (!meta) continue;
    if (!tools[toolName]) tools[toolName] = { ...meta, plans: {} };
    tools[toolName].plans[row.plan_name] = hoursToPlanDef(row.validity_hours, row.price_cents);
  }
  return Object.freeze(tools);
}

async function loadCatalog(pool) {
  const { rows } = await pool.query(
    `SELECT tool_id, plan_name, price_cents, validity_hours
     FROM catalog_plans WHERE deleted_at IS NULL ORDER BY sort_order`
  );
  return buildTools(rows);
}

module.exports = { loadCatalog, TOOL_ID_TO_NAME, TOOL_META };

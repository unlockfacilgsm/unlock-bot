'use strict';

// =============================================================================
// Resumo diário no canal 🔔・alertas (pedido do Weverton em 14/11/2026): uma vez
// por dia, a partir das 8h (Brasília), o que aconteceu nas últimas 24 h com as
// contas — trocas de senha automáticas, falhas, reciclos do site, contas
// reprovadas, conflitos — e o que ainda está no /vencidas.
// Fonte: tabela `notifications` do site (onde o bot, o checador e o trocador
// registram tudo) + os vencimentos pendentes do Discord.
// =============================================================================

const { dateKey } = require('./dates');

const HOUR_BR = 8;
const MAX_LINES = 8;

function hourBR(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(now));
}

// Pura: monta o texto a partir das notificações e dos vencimentos pendentes.
function buildSummary({ notes, pending, day }) {
  const by = (type) => notes.filter((n) => n.type === type).map((n) => n.message);
  const list = (items) => items.slice(0, MAX_LINES).map((m) => `• ${m}`).concat(items.length > MAX_LINES ? [`• … e mais ${items.length - MAX_LINES}`] : []);
  const released = by('account.auto_released');
  const failed = [...by('account.auto_rotate_failed'), ...by('checker.rotate_failed')];
  const recycled = by('checker.recycled');
  const dead = by('checker.unavailable');
  const conflicts = by('account.sync_conflict');
  const [y, m, d] = day.split('-');
  const lines = [`📋 **RESUMO DO DIA — ${d}/${m}/${y}** (últimas 24 h)`, ''];
  lines.push(`🔄 Trocas automáticas no Discord: **${released.length}**`, ...list(released));
  lines.push('', `♻️ Reciclos pelo site: **${recycled.length}**`);
  lines.push('', `⚠️ Trocas que falharam: **${failed.length}**`, ...list(failed));
  lines.push('', `🚫 Contas reprovadas pelo checador: **${dead.length}**`, ...list(dead));
  if (conflicts.length) lines.push('', `❗ Conflitos de sincronia: **${conflicts.length}**`, ...list(conflicts));
  const byTool = {};
  for (const v of pending) byTool[v.tool] = (byTool[v.tool] || 0) + 1;
  const pend = Object.entries(byTool).map(([t, n]) => `${t}: ${n}`).join(' · ');
  lines.push('', `⏰ Ainda no /vencidas (troca manual): **${pending.length}**${pend ? ` — ${pend}` : ''}`);
  return lines.join('\n').slice(0, 1990);
}

class DailySummary {
  constructor({ pool, store, transport, guildId, logger = console, clock = () => new Date() }) {
    Object.assign(this, { pool, store, transport, guildId, logger, clock });
  }

  async run(guild) {
    const now = this.clock();
    if (hourBR(now) < HOUR_BR) return null;
    const day = dateKey(now);
    if (await this.store.getConfig(this.guildId, 'dailySummaryDay', null) === day) return null;
    const channel = await this.transport.getChannel?.(guild, 'alertas');
    if (!channel) return null;
    const { rows: notes } = await this.pool.query(
      `SELECT type, message FROM notifications WHERE created_at > now() - interval '24 hours'
         AND type IN ('account.auto_released','account.auto_rotate_failed','checker.rotate_failed','checker.recycled','checker.unavailable','account.sync_conflict')
       ORDER BY created_at`);
    const pending = (await this.store.listRecords(this.guildId, 'vencimentos')).filter((v) => v.status === 'pending');
    // Marca antes de enviar: se o envio falhar, não repete a cada 30 s (tenta de novo amanhã).
    await this.store.setConfig(this.guildId, 'dailySummaryDay', day);
    await channel.send({ content: buildSummary({ notes, pending, day }), allowedMentions: { parse: [] } });
    this.logger.log(`[resumo] Resumo diário de ${day} enviado em #alertas.`);
    return day;
  }
}

module.exports = { DailySummary, buildSummary, hourBR };

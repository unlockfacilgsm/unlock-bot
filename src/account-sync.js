'use strict';

const crypto = require('crypto');

// =============================================================================
// Sincronia de contas Discord ⇄ estoque do site (Unlock Tool e TSM Tool).
// Uma conta é a mesma dos dois lados quando a ferramenta e o login batem.
// Regras (decididas pelo Weverton em 13/11/2026):
//   - conta nova de um lado aparece no outro;
//   - em uso de um lado = ocupada do outro (evita venda dupla);
//   - reprovada pelo checador do site sai do estoque do Discord;
//   - senha diferente: vale a que o checador validou; sem validação, a mais recente.
// O bot grava no Discord num único evento por rodada; o site é atualizado com
// UPDATEs condicionais (só muda se a linha ainda está no estado esperado).
// =============================================================================

const SYNC_TOOLS = { unlocktool: 'Unlock Tool', tsmtool: 'TSM Tool' };
const NAME_TO_TOOL = Object.fromEntries(Object.entries(SYNC_TOOLS).map(([id, name]) => [name, id]));
const UT_INSTRUCTION = '⚠️ POSSIVEIS ERROS:\nERRO 200: Clique em Login novamente.\nERRO 400: Copie e cole os dados novamente, sem espaços no início ou final.';
const ALIVE = ['VALID', 'IN_USE'];

const keyOf = (toolId, login) => `${toolId}|${String(login || '').trim().toLowerCase()}`;
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

// Situação de cada lado, já interpretada.
function botState(b) {
  if (!b) return null;
  if (b.activeSaleId || b.needsPasswordReset || b.pendingDelivery) return 'discord';   // venda do Discord manda
  if (b.status === 'occupied') return b.syncLocked ? 'locked' : 'discord';           // ocupada antiga sem venda: trata como do Discord
  return 'free';
}
function siteState(s) {
  if (!s) return null;
  if (s.status === 'unavailable') return 'dead';
  if (s.status === 'sold' && s.sync_locked && !s.order_id && !s.reserved_order_id) return 'locked';   // travada pela sincronia (em uso no Discord)
  if (s.status === 'reserved' || s.order_id || s.reserved_order_id) return 'site';   // pedido do site em andamento ou entregue
  if (s.status === 'sold') return 'legacy';   // vendida sem pedido: veio da migração antiga do Discord (o Discord é quem sabe)
  return 'free';
}

// Entre linhas repetidas no site, a que importa: viva antes de morta, depois a mais nova.
function pickSite(rows) {
  const rank = (s) => ({ site: 0, locked: 1, legacy: 2, free: 3, dead: 4 })[siteState(s)];
  return rows.slice().sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id))[0];
}

// Calcula o que mudar. Pura: recebe as contas dos dois lados e devolve as operações.
// skip: contas em troca de senha automática (expiry-rotation) — ninguém mexe até terminar.
function planSync(botAccounts, siteRows, skip = new Set()) {
  const bot = new Map(), site = new Map();
  for (const b of botAccounts) {
    const toolId = NAME_TO_TOOL[b.tool];
    if (toolId) bot.set(keyOf(toolId, b.login), { ...b, toolId });
  }
  for (const s of siteRows) {
    if (!SYNC_TOOLS[s.tool_id] || !s.login) continue;
    const k = keyOf(s.tool_id, s.login);
    site.set(k, site.has(k) ? pickSite([site.get(k), s]) : s);
  }
  const botOps = [], siteOps = [], conflicts = [];
  const lockSite = (s, why) => siteOps.push({ op: 'lock', id: s.id, why });
  const freeSite = (s, password) => siteOps.push({ op: 'free', id: s.id, password });

  for (const k of new Set([...bot.keys(), ...site.keys()])) {
    if (skip.has(k)) continue;
    const b = bot.get(k), s = site.get(k);
    const bs = botState(b), ss = siteState(s);

    if (b && !s) {
      // Só no Discord → entra no site (livre, ou travada se está em uso no Discord).
      if (bs === 'locked') botOps.push({ op: 'remove', accountId: b.id, reason: 'conta saiu do estoque do site' });
      else siteOps.push({ op: 'insert', toolId: b.toolId, login: b.login.trim(), password: b.password, status: bs === 'free' ? 'available' : 'sold' });
      continue;
    }
    if (s && !b) {
      // Só no site → entra no Discord (reprovadas não entram).
      if (ss === 'dead') continue;
      if (ss === 'locked') { siteOps.push({ op: 'kill', id: s.id, why: 'conta excluída do Discord' }); continue; }
      botOps.push({ op: 'add', tool: SYNC_TOOLS[s.tool_id], login: s.login.trim(), password: s.password, status: ss === 'free' ? 'available' : 'occupied' });
      continue;
    }

    // Nos dois lados.
    // Pedido do site ligado à venda do Discord (registrada à mão): é a mesma venda, não conflito.
    if (bs === 'discord' && ss === 'site' && b.activeSaleId && s.order_discord_sale_id === b.activeSaleId) continue;
    if (bs === 'discord' && ss === 'site') { conflicts.push({ key: k, botId: b.id, siteId: s.id, msg: `Conta ${b.login} (${SYNC_TOOLS[s.tool_id]}) em uso NOS DOIS LADOS: venda ${b.activeSaleId || 'no Discord'} e pedido do site #${s.order_id || s.reserved_order_id || s.id}` }); continue; }
    if (ss === 'dead') {
      if (bs === 'free' || bs === 'locked') botOps.push({ op: 'remove', accountId: b.id, reason: `reprovada pelo checador do site (${s.last_check_status || 'indisponível'})` });
      continue;
    }

    // Senha: quem manda nesta conta agora define a senha.
    let password = null, passwordTo = null;
    if (b.password !== s.password) {
      // O trocador do site trocou a senha DEPOIS da última mudança no Discord: a do site é a real
      // no unlocktool.net (antes a do Discord voltava por cima — caso da #281 em 13/11).
      if (s.last_rotate_status === 'RECYCLED' && time(s.last_rotate_at) > time(b.updatedAt)) passwordTo = 'bot';
      else if (bs === 'discord' || ss === 'locked' || ss === 'legacy') passwordTo = 'site';   // Discord usa / liberou / é dono do registro antigo
      else if (ss === 'site') passwordTo = 'bot';                                  // site está usando
      else if (ALIVE.includes(s.last_check_status) && time(s.last_check_at) >= time(b.updatedAt)) passwordTo = 'bot';  // senha do site validada
      else passwordTo = time(b.updatedAt) > Math.max(time(s.last_rotate_at), time(s.created_at)) ? 'site' : 'bot';
      password = passwordTo === 'site' ? b.password : s.password;
    }

    if (bs === 'discord') {
      if (ss === 'legacy') { siteOps.push({ op: 'adopt', id: s.id, password: passwordTo === 'site' ? password : null }); continue; }
      if (ss === 'free') lockSite(s, `em uso no Discord (${b.activeSaleId || 'aguardando troca de senha'})`);
      if (passwordTo === 'site') siteOps.push({ op: 'password', id: s.id, password });
      if (passwordTo === 'bot') botOps.push({ op: 'update', accountId: b.id, status: 'occupied', password });
      continue;
    }
    if (ss === 'legacy') {
      // Registro antigo da migração: o Discord diz que a conta está livre → libera no site.
      if (bs === 'free') siteOps.push({ op: 'freeLegacy', id: s.id, password: passwordTo === 'site' ? password : null });
      continue;
    }
    if (ss === 'site') {
      if (bs === 'free' || passwordTo === 'bot') botOps.push({ op: 'update', accountId: b.id, status: 'occupied', ...(passwordTo === 'bot' ? { password } : {}) });
      continue;
    }
    if (ss === 'locked') {
      // Travada pela sincronia e o Discord já liberou: volta a ficar livre no site (com a senha do Discord).
      // Travada dos dois lados não deveria acontecer; na dúvida, não libera nada.
      if (bs === 'free') freeSite(s, passwordTo === 'site' ? password : null);
      continue;
    }
    // Site livre.
    if (bs === 'locked' || passwordTo === 'bot') botOps.push({ op: 'update', accountId: b.id, status: 'available', ...(passwordTo === 'bot' ? { password } : {}) });
    if (passwordTo === 'site') siteOps.push({ op: 'password', id: s.id, password });
  }
  return { botOps, siteOps, conflicts };
}

class AccountSync {
  constructor({ pool, store, guildId, siteKey, logger = console, dryRun = false }) {
    Object.assign(this, { pool, store, guildId, logger, dryRun });
    this.siteKey = siteKey && /^[a-fA-F0-9]{64}$/.test(siteKey) ? Buffer.from(siteKey, 'hex') : null;
    this.lastRunAt = 0;
    this.running = null;
    this.reported = new Set();
  }

  get enabled() { return !!(this.pool && this.siteKey); }

  _decrypt(data) {
    const b = Buffer.from(data, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.siteKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const raw = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    try { const v = JSON.parse(raw); if (v && typeof v === 'object') return { login: String(v.login || ''), password: String(v.password || ''), instruction: String(v.instruction || '') }; } catch {}
    return { login: (raw.match(/^Login:\s*(.*)$/im) || [])[1] || '', password: (raw.match(/^Senha:\s*(.*)$/im) || [])[1] || '', instruction: '' };
  }

  _encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.siteKey, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }

  // Coluna que marca as contas travadas pela sincronia (aditiva; o site não depende dela).
  async _ensureSchema() {
    if (this.schemaReady) return;
    await this.pool.query('ALTER TABLE stock ADD COLUMN IF NOT EXISTS sync_locked boolean NOT NULL DEFAULT false');
    this.schemaReady = true;
  }

  async _siteRows() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.tool_id, s.status, s.encrypted_credentials, s.last_check_status, s.last_check_at, s.last_rotate_status, s.last_rotate_at, s.created_at, s.order_id, s.reserved_order_id,
              COALESCE((to_jsonb(s) ->> 'sync_locked')::boolean, false) AS sync_locked, o.discord_sale_id AS order_discord_sale_id
       FROM stock s LEFT JOIN orders o ON o.id = s.order_id WHERE s.tool_id = ANY($1::text[])`, [Object.keys(SYNC_TOOLS)]);
    return rows.map((r) => {
      try { const c = this._decrypt(r.encrypted_credentials); return { ...r, login: c.login, password: c.password, instruction: c.instruction }; }
      catch { return { ...r, login: '', password: '' }; }
    });
  }

  async _firstPlan(toolId) {
    const { rows } = await this.pool.query(`SELECT id FROM catalog_plans WHERE tool_id = $1 AND deleted_at IS NULL ORDER BY sort_order, id LIMIT 1`, [toolId]);
    return rows[0]?.id || `${toolId}-12h`;
  }

  async _applySite(ops, siteRows) {
    const byId = new Map(siteRows.map((r) => [String(r.id), r]));
    let done = 0;
    for (const op of ops) {
      try {
        if (op.op === 'insert') {
          const fp = crypto.createHash('sha256').update(`${op.toolId}:${op.login.trim().toLowerCase()}`).digest('hex');
          const creds = this._encrypt({ login: op.login, password: op.password, instruction: op.toolId === 'unlocktool' ? UT_INSTRUCTION : '' });
          const r = await this.pool.query(
            `INSERT INTO stock (plan_id, tool_id, encrypted_credentials, status, cred_fp, check_requested_at, sync_locked)
             SELECT $1, $2, $3, $4, $5, CASE WHEN $4 = 'available' THEN now() END, $4 = 'sold'
             WHERE NOT EXISTS (SELECT 1 FROM stock WHERE cred_fp = $5)`,
            [await this._firstPlan(op.toolId), op.toolId, creds, op.status, fp]);
          done += r.rowCount;
        } else if (op.op === 'lock') {
          done += (await this.pool.query(`UPDATE stock SET status = 'sold', sync_locked = true, reserved_order_id = NULL, reservation_expires_at = NULL WHERE id = $1 AND status = 'available'`, [op.id])).rowCount;
        } else if (op.op === 'kill') {
          done += (await this.pool.query(`UPDATE stock SET status = 'unavailable', sync_locked = false WHERE id = $1 AND status = 'sold' AND sync_locked AND order_id IS NULL AND reserved_order_id IS NULL`, [op.id])).rowCount;
        } else if (op.op === 'adopt' || op.op === 'freeLegacy') {
          const row = byId.get(String(op.id));
          const params = [op.id];
          const sets = [op.op === 'adopt' ? 'sync_locked = true' : `status = 'available', check_requested_at = now()`];
          if (op.password != null && row) {
            params.push(this._encrypt({ login: row.login, password: op.password, instruction: row.instruction || '' }));
            sets.push(`encrypted_credentials = $${params.length}`);
          }
          done += (await this.pool.query(`UPDATE stock SET ${sets.join(', ')} WHERE id = $1 AND status = 'sold' AND order_id IS NULL AND reserved_order_id IS NULL AND NOT sync_locked`, params)).rowCount;
        } else if (op.op === 'free' || op.op === 'password') {
          const row = byId.get(String(op.id));
          const sets = []; const params = [op.id];
          if (op.password != null && row) {
            params.push(this._encrypt({ login: row.login, password: op.password, instruction: row.instruction || '' }));
            sets.push(`encrypted_credentials = $${params.length}`, 'check_requested_at = now()');
          }
          if (op.op === 'free') sets.push(`status = 'available'`, 'sync_locked = false', 'check_requested_at = now()');
          if (!sets.length) continue;
          const guard = op.op === 'free' ? `AND status = 'sold' AND sync_locked AND order_id IS NULL AND reserved_order_id IS NULL` : '';
          done += (await this.pool.query(`UPDATE stock SET ${[...new Set(sets)].join(', ')} WHERE id = $1 ${guard}`, params)).rowCount;
        }
      } catch (error) {
        this.logger.error(`[account-sync] site ${op.op} ${op.id || op.login}: ${error.message}`);
      }
    }
    return done;
  }

  async _notify(conflicts) {
    for (const c of conflicts) {
      if (this.reported.has(c.key)) continue;
      this.reported.add(c.key);
      this.logger.error(`[account-sync] CONFLITO: ${c.msg}`);
      await this.pool.query(`INSERT INTO notifications (type, message, metadata) VALUES ('account.sync_conflict', $1, $2::jsonb)`,
        [c.msg, JSON.stringify({ botId: c.botId, siteId: c.siteId })]).catch(() => {});
    }
  }

  // Uma rodada completa. minIntervalMs evita rodar de novo logo em seguida (tick de 30 s).
  async run({ minIntervalMs = 0 } = {}) {
    if (!this.enabled) return null;
    if (this.running) return this.running;
    if (minIntervalMs && Date.now() - this.lastRunAt < minIntervalMs) return null;
    this.running = (async () => {
      try {
        if (!this.dryRun) await this._ensureSchema();
        const botAccounts = (await this.store.listAccounts(this.guildId)).filter((a) => NAME_TO_TOOL[a.tool]);
        const siteRows = await this._siteRows();
        const plan = planSync(botAccounts, siteRows, this.skip?.() ?? new Set());
        if (this.dryRun) {
          this.logger.log(`[account-sync] (simulação) Discord: ${plan.botOps.length} mudança(s) · site: ${plan.siteOps.length} · conflitos: ${plan.conflicts.length}`);
          return { ...plan, dryRun: true };
        }
        const siteDone = plan.siteOps.length ? await this._applySite(plan.siteOps, siteRows) : 0;
        const botResults = plan.botOps.length ? await this.store.syncAccounts(this.guildId, plan.botOps) : [];
        const botDone = botResults.filter((r) => !r.skipped && !r.error).length;
        for (const r of botResults) if (r.error) this.logger.error(`[account-sync] Discord ${r.op} ${r.id || r.login}: ${r.error}`);
        await this._notify(plan.conflicts);
        if (siteDone || botDone) this.logger.log(`[account-sync] Discord: ${botDone} mudança(s) · site: ${siteDone} mudança(s)${plan.conflicts.length ? ` · ${plan.conflicts.length} conflito(s)` : ''}`);
        return { ...plan, siteDone, botDone, botResults };
      } finally {
        this.lastRunAt = Date.now();
        this.running = null;
      }
    })();
    return this.running;
  }
}

module.exports = { AccountSync, planSync, SYNC_TOOLS };

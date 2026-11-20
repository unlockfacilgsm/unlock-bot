'use strict';

// =============================================================================
// Vencidas do Discord (VENC pendentes) resolvidas sozinhas (pedido do Weverton, 14/11/2026):
//   - Unlock Tool: pede a troca de senha ao trocador da VPS (fila do site,
//     stock.rotate_requested_at). Quando o trocador confirma (RECYCLED), libera a
//     conta no Discord com a senha nova — o mesmo que /trocar-senhas VENC-xxx.
//   - AMT Tool 12 horas: ativação por AnyDesk, o cliente nunca recebe a senha;
//     a conta volta ao estoque sem troca.
//   - TSM e os demais: continuam manuais (aparecem em /vencidas).
// Se a troca falhar (senha antiga errada etc.), o vencimento fica em /vencidas.
// Vencimentos de pedidos do SITE já são trocados pelo backend; a sincronia de
// contas leva a senha nova para o Discord.
// =============================================================================

const keyOf = (toolId, login) => `${toolId}|${String(login || '').trim().toLowerCase()}`;
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);
const REQUEST_GRACE_MS = 30 * 60_000;   // não pede de novo enquanto o trocador trabalha

const isAmt12h = (tool, plan) => tool === 'AMT Tool' && /^12\s*h/i.test(String(plan || '').trim());

// Pura: decide o que fazer com cada vencimento pendente.
// pending: VENC pendentes; sales: Map saleId → venda; accounts: Map accountId → conta (com senha);
// site: Map key → linha do estoque do site (Unlock Tool, já decifrada); requested: Map siteId → ms do pedido.
function planExpiry({ pending, sales, accounts, site, requested = new Map(), now = Date.now() }) {
  const out = { releaseAmt: [], requestRotate: [], releaseRotated: [], failed: [], inFlight: new Set() };
  for (const v of pending) {
    const sale = sales.get(v.saleId);
    const acc = accounts.get(sale?.accountId || v.accountId);
    if (!sale || !acc || acc.activeSaleId !== sale.id) continue;
    const plan = sale.currentPlan || sale.plan;
    if (isAmt12h(v.tool, plan)) { out.releaseAmt.push({ id: v.id, password: acc.password, login: acc.login }); continue; }
    if (v.tool !== 'Unlock Tool') continue;
    const k = keyOf('unlocktool', acc.login);
    const s = site.get(k);
    if (!s) continue;   // a sincronia ainda vai criar a linha no site
    const rotatedAfter = time(s.last_rotate_at) >= time(v.registeredAt);
    // Senha já trocada pelo trocador depois do vencimento (livre, travada pela sincronia ou até
    // reprovada depois pelo checador — ex.: licença da conta expirada): libera no Discord com a
    // senha nova; se o site reprovou, a sincronia tira a conta do estoque do Discord.
    if (s.last_rotate_status === 'RECYCLED' && rotatedAfter && s.password && !s.order_id && !s.reserved_order_id) {
      out.releaseRotated.push({ id: v.id, password: s.password, siteId: s.id, login: acc.login });
      out.inFlight.add(k);
    } else if (s.rotate_requested_at || now - (requested.get(String(s.id)) || 0) < REQUEST_GRACE_MS) {
      out.inFlight.add(k);   // na fila ou sendo trocada agora
    } else if (s.status === 'unavailable' && rotatedAfter) {
      out.failed.push({ id: v.id, siteId: s.id, login: acc.login, status: s.last_rotate_status });
    } else if (s.status === 'sold' && !s.order_id && !s.reserved_order_id && !rotatedAfter && s.password === acc.password) {
      out.requestRotate.push({ id: v.id, siteId: s.id, login: acc.login });
      out.inFlight.add(k);
    }
  }
  // Recém-liberadas no Discord, ainda publicando: a sincronia não mexe até terminar.
  for (const acc of accounts.values()) {
    if (acc.pendingDelivery && acc.pendingExpirationId && acc.tool === 'Unlock Tool') out.inFlight.add(keyOf('unlocktool', acc.login));
  }
  return out;
}

class ExpiryRotation {
  constructor({ accountSync, store, guildId, logger = console }) {
    Object.assign(this, { accountSync, store, guildId, logger });
    this.requested = new Map();
    this.reported = new Set();
    this.inFlight = new Set();
    this.lastRunAt = 0;
    this.running = null;
  }

  get enabled() { return !!this.accountSync?.enabled; }

  async run({ minIntervalMs = 0 } = {}) {
    if (!this.enabled) return null;
    if (this.running) return this.running;
    if (minIntervalMs && Date.now() - this.lastRunAt < minIntervalMs) return null;
    this.running = this._run().finally(() => { this.lastRunAt = Date.now(); this.running = null; });
    return this.running;
  }

  async _run() {
    const pool = this.accountSync.pool;
    const pending = (await this.store.listRecords(this.guildId, 'vencimentos')).filter((v) => v.status === 'pending');
    const accountsList = await this.store.listAccounts(this.guildId);
    const accounts = new Map(accountsList.map((a) => [a.id, a]));
    const sales = new Map();
    for (const v of pending) { const s = await this.store.getRecord(this.guildId, 'vendas', v.saleId); if (s) sales.set(s.id, s); }
    const site = new Map();
    const { rows } = await pool.query(
      `SELECT id, tool_id, status, encrypted_credentials, last_rotate_status, last_rotate_at, rotate_requested_at, order_id, reserved_order_id,
              COALESCE((to_jsonb(s) ->> 'sync_locked')::boolean, false) AS sync_locked
       FROM stock s WHERE tool_id = 'unlocktool'`);
    for (const r of rows) {
      try { const c = this.accountSync._decrypt(r.encrypted_credentials); site.set(keyOf('unlocktool', c.login), { ...r, login: c.login, password: c.password }); } catch {}
    }
    const plan = planExpiry({ pending, sales, accounts, site, requested: this.requested });
    this.inFlight = plan.inFlight;
    const note = (type, msg, meta) => pool.query('INSERT INTO notifications (type, message, metadata) VALUES ($1, $2, $3::jsonb)', [type, msg, JSON.stringify(meta)]).catch(() => {});

    for (const r of plan.requestRotate) {
      const res = await pool.query(
        `UPDATE stock SET rotate_requested_at = now(), rotate_attempts = 0
         WHERE id = $1 AND status = 'sold' AND order_id IS NULL AND reserved_order_id IS NULL AND rotate_requested_at IS NULL`, [r.siteId]);
      if (res.rowCount) {
        this.requested.set(String(r.siteId), Date.now());
        this.logger.log(`[auto-troca] ${r.id}: troca de senha pedida ao trocador (${r.login}, site #${r.siteId}).`);
      }
    }
    for (const r of [...plan.releaseRotated, ...plan.releaseAmt]) {
      const rotated = plan.releaseRotated.includes(r);
      const result = await this.store.releaseAccounts(this.guildId, { expirationIds: [r.id], newPassword: r.password, actorId: 'auto-troca', registeredAt: new Date().toISOString() });
      if (result.changed.length) {
        if (rotated) await pool.query('UPDATE stock SET sync_locked = false WHERE id = $1 AND status = $2', [r.siteId, 'available']).catch(() => {});
        const msg = rotated ? `${r.id}: senha trocada pelo trocador e conta ${r.login} de volta ao estoque (Discord e site).`
          : `${r.id}: AMT 12 horas (AnyDesk) — conta ${r.login} de volta ao estoque sem troca de senha.`;
        this.logger.log(`[auto-troca] ${msg}`);
        await note('account.auto_released', msg, { expirationId: r.id, siteId: r.siteId || null });
      } else {
        for (const e of result.errors) this.logger.error(`[auto-troca] ${e.id}: ${e.message}`);
      }
    }
    for (const f of plan.failed) {
      if (this.reported.has(f.id)) continue;
      this.reported.add(f.id);
      // Já avisado antes (inclusive antes de um reinício do bot): não repete.
      const seen = await pool.query(`SELECT 1 FROM notifications WHERE type = 'account.auto_rotate_failed' AND message LIKE $1 LIMIT 1`, [`${f.id}:%`]).catch(() => ({ rowCount: 0 }));
      if (seen.rowCount) continue;
      const msg = `${f.id}: o trocador não conseguiu trocar a senha de ${f.login} (${f.status || 'erro'}) — trocar manualmente (/vencidas).`;
      this.logger.error(`[auto-troca] ${msg}`);
      await note('account.auto_rotate_failed', msg, { expirationId: f.id, siteId: f.siteId });
    }
    return plan;
  }
}

module.exports = { ExpiryRotation, planExpiry, isAmt12h };

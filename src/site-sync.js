'use strict';

class SiteSync {
  constructor({ pool, logger = console }) {
    this.pool = pool;
    this.logger = logger;
  }

  async _upsert(eventType, recordId, data) {
    if (!this.pool) return;
    const eventId = `${eventType}:${recordId}:${data.registeredAt || new Date().toISOString()}`;
    try {
      await this.pool.query(
        `INSERT INTO discord_sync (event_type, event_id, record_id, tool, client, plan, price_cents, discount_cents, registered_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (event_id) DO UPDATE SET
           tool = EXCLUDED.tool, client = EXCLUDED.client, plan = EXCLUDED.plan,
           price_cents = EXCLUDED.price_cents, discount_cents = EXCLUDED.discount_cents,
           metadata = EXCLUDED.metadata, synced_at = now()`,
        [
          eventType, eventId, recordId,
          data.tool || null, data.client || null, data.plan || data.currentPlan || null,
          data.priceCents ?? null, data.discountCents ?? 0,
          data.registeredAt || new Date().toISOString(),
          JSON.stringify(data.metadata || {})
        ]
      );
    } catch (error) {
      this.logger.error(`[site-sync] ${eventType} ${recordId}: ${error.message}`);
    }
  }

  async syncSale(record) {
    // A chave do evento inclui a data: se a data da venda foi corrigida, o registro antigo sai (senão a venda contaria 2x).
    if (this.pool && record.registeredAt) {
      await this.pool.query(`DELETE FROM discord_sync WHERE event_type = 'sale' AND record_id = $1 AND registered_at <> $2::timestamptz`, [record.id, record.registeredAt])
        .catch(error => this.logger.error(`[site-sync] sale ${record.id}: ${error.message}`));
    }
    await this._upsert('sale', record.id, {
      tool: record.tool, client: record.client,
      plan: record.currentPlan || record.plan,
      priceCents: record.priceCents, discountCents: record.discountCents,
      registeredAt: record.registeredAt,
      metadata: { status: record.status, expiresAt: record.expiresAt, credits: record.credits, oneTime: record.oneTime, login: record.login || null,
        ...(record.siteOrder ? { source: record.source, siteOrder: record.siteOrder } : {}) }
    });
  }

  async syncRenewal(record) {
    await this._upsert('renewal', record.id, {
      tool: record.tool, client: record.client, plan: record.plan,
      priceCents: record.priceCents, discountCents: record.discountCents,
      registeredAt: record.registeredAt,
      metadata: { saleId: record.saleId, expiresAt: record.expiresAt }
    });
  }

  async syncTrade(record) {
    await this._upsert('trade', record.id, {
      tool: record.tool, client: record.client,
      plan: record.newPlan || record.previousPlan,
      registeredAt: record.registeredAt,
      metadata: { saleId: record.saleId, reason: record.reason, previousPlan: record.previousPlan, newPlan: record.newPlan }
    });
  }

  async syncExpiration(record) {
    await this._upsert('expiration', record.id, {
      tool: record.tool, client: record.client,
      registeredAt: record.registeredAt,
      metadata: { saleId: record.saleId, expiresAt: record.expiresAt, status: record.status }
    });
  }

  // Registro excluído no Discord (/excluir): sai também do painel do site, com os vinculados à venda.
  async deleteRecord(recordId) {
    if (!this.pool || !recordId) return 0;
    try {
      const r = await this.pool.query(`DELETE FROM discord_sync WHERE record_id = $1 OR metadata->>'saleId' = $1`, [recordId]);
      return r.rowCount;
    } catch (error) {
      this.logger.error(`[site-sync] excluir ${recordId}: ${error.message}`);
      return 0;
    }
  }

  async syncAdExpense(expense) {
    await this._upsert('ad_expense', expense.id, {
      registeredAt: expense.createdAt || expense.date,
      priceCents: expense.amountCents,
      metadata: { date: expense.date, description: expense.description }
    });
  }

  // Alinha os gastos com anúncios do site com os do Discord (a fonte): corrige valor, data e
  // descrição diferentes, cria os que faltam e apaga os que não existem mais (ou duplicados).
  // Só escreve quando há diferença. Devolve quantos registros mudaram.
  async reconcileAdExpenses(expenses) {
    if (!this.pool || !Array.isArray(expenses)) return 0;
    if (this._reconciling) return 0;
    this._reconciling = true;
    try {
      const { rows } = await this.pool.query(`SELECT event_id, record_id, price_cents, metadata FROM discord_sync WHERE event_type = 'ad_expense'`);
      // Trava: lista vazia (ou que sumiria mais da metade) com o site cheio = provável falha ao ler o
      // Discord, não exclusão de verdade. Nesse caso não apaga nada.
      const missing = rows.filter(r => !expenses.some(e => e.id === r.record_id)).length;
      if (rows.length && (!expenses.length || missing > rows.length / 2)) {
        this.logger.error(`[site-sync] alinhar gastos com anúncios: ${missing} de ${rows.length} sumiriam — nada apagado (conferir o Discord).`);
        return 0;
      }
      const byId = new Map(expenses.map(e => [e.id, e]));
      const keep = new Map();   // record_id -> event_id esperado
      for (const e of expenses) keep.set(e.id, `ad_expense:${e.id}:${e.createdAt || e.date}`);
      let changed = 0;
      for (const row of rows) {
        const e = byId.get(row.record_id);
        if (!e || row.event_id !== keep.get(row.record_id)) {
          await this.pool.query(`DELETE FROM discord_sync WHERE event_id = $1`, [row.event_id]);
          changed++;
        }
      }
      const present = new Map(rows.filter(r => byId.has(r.record_id) && r.event_id === keep.get(r.record_id)).map(r => [r.record_id, r]));
      for (const e of expenses) {
        const row = present.get(e.id);
        const meta = row?.metadata || {};
        const same = row && Number(row.price_cents) === e.amountCents && meta.date === e.date && (meta.description || '') === (e.description || '');
        if (same) continue;
        await this.syncAdExpense(e);
        changed++;
      }
      if (changed) this.logger.log?.(`[site-sync] gastos com anúncios alinhados com o Discord: ${changed} correção(ões).`);
      return changed;
    } catch (error) {
      this.logger.error(`[site-sync] alinhar gastos com anúncios: ${error.message}`);
      return 0;
    } finally {
      this._reconciling = false;
    }
  }
}

module.exports = { SiteSync };

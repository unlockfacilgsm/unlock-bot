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
    await this._upsert('sale', record.id, {
      tool: record.tool, client: record.client,
      plan: record.currentPlan || record.plan,
      priceCents: record.priceCents, discountCents: record.discountCents,
      registeredAt: record.registeredAt,
      metadata: { status: record.status, expiresAt: record.expiresAt, credits: record.credits, oneTime: record.oneTime,
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

  async syncAdExpense(expense) {
    await this._upsert('ad_expense', expense.id, {
      registeredAt: expense.createdAt || expense.date,
      priceCents: expense.amountCents,
      metadata: { date: expense.date, description: expense.description }
    });
  }
}

module.exports = { SiteSync };

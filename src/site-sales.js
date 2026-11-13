'use strict';

const catalog = require('./catalog');
const { TOOL_ID_TO_NAME } = require('./catalog-sync');

// Delivered site orders become /vender sales in Discord. An order is marked only
// after the Discord event is written; createSiteSale recognises a repeated order.
class SiteSales {
  constructor({ pool, store, guildId, siteSync = null, logger = console }) {
    Object.assign(this, { pool, store, guildId, siteSync, logger });
  }

  target(order) {
    if (order.origin === 'course') return { tool: 'Unlock Tool', plan: catalog.COURSE_PLAN };
    const tool = TOOL_ID_TO_NAME[String(order.plan_id).split('-')[0]];
    return tool ? { tool, plan: order.plan_name } : null;
  }

  async mark(orderId, value) {
    await this.pool.query('UPDATE orders SET discord_sale_id = $1 WHERE id = $2 AND discord_sale_id IS NULL', [value, orderId]);
  }

  async run() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(
      `SELECT id, order_code, plan_id, plan_name, amount_cents, buyer_name, phone, buyer_email, origin,
              delivered_at, paid_at, license_expires_at
       FROM orders
       WHERE status = 'delivered' AND discord_sale_id IS NULL AND origin IN ('site', 'whatsapp', 'course')
       ORDER BY delivered_at NULLS LAST, id LIMIT 20`
    );
    let registered = 0;
    for (const order of rows) {
      const target = this.target(order);
      if (!target) {
        this.logger.log(`[site-sales] ${order.order_code}: ferramenta ${order.plan_id} sem correspondente no bot; ignorado.`);
        await this.mark(order.id, 'ignorado');
        continue;
      }
      try {
        const client = String(order.buyer_name || order.phone || order.buyer_email || 'Cliente do site').replace(/\s+/g, ' ').trim().slice(0, 500);
        const sale = await this.store.createSiteSale(this.guildId, {
          siteOrder: order.order_code, source: order.origin === 'whatsapp' ? 'whatsapp' : 'site',
          client, tool: target.tool, plan: target.plan, priceCents: order.amount_cents,
          registeredAt: order.delivered_at || order.paid_at, expiresAt: order.license_expires_at,
        });
        await this.siteSync?.syncSale(sale);
        await this.mark(order.id, sale.id);
        registered++;
      } catch (error) {
        this.logger.error(`[site-sales] ${order.order_code}: ${error.message}`);
      }
    }
    return registered;
  }
}

module.exports = { SiteSales };

'use strict';

const catalog = require('./catalog');
const { TOOL_ID_TO_NAME } = require('./catalog-sync');

// Telefone no formato das vendas manuais: "+55 21 98480-7044". Sem telefone válido, null.
function formatPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55\d{10,11}$/.test(d)) return d.length >= 8 ? '+' + d : null;
  const ddd = d.slice(2, 4), n = d.slice(4);
  return `+55 ${ddd} ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
}
// Cliente registrado no Discord: o telefone (pedido do Weverton, 14/11/2026); sem telefone, nome ou e-mail.
const clientOf = (order) => String(formatPhone(order.phone) || order.buyer_name || order.buyer_email || 'Cliente do site').replace(/\s+/g, ' ').trim().slice(0, 100);

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
        const client = clientOf(order);
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

// Uma vez só: vendas do site já registradas com o nome passam a mostrar o telefone.
SiteSales.prototype.fixClients = async function fixClients() {
  if (!this.pool || await this.store.getConfig(this.guildId, 'siteSaleClientsPhone', false)) return 0;
  const sales = (await this.store.listRecords(this.guildId, 'vendas')).filter((s) => s.siteOrder);
  const { rows } = await this.pool.query('SELECT order_code, phone FROM orders WHERE order_code = ANY($1::text[])', [sales.map((s) => s.siteOrder)]);
  const byCode = new Map(rows.map((r) => [r.order_code, r]));
  let changed = 0;
  for (const sale of sales) {
    const client = formatPhone(byCode.get(sale.siteOrder)?.phone);
    if (!client || client === sale.client) continue;
    try {
      const edited = await this.store.editSale(this.guildId, { saleId: sale.id, changes: { client }, actorId: 'site-sales', editedAt: new Date().toISOString() });
      await this.siteSync?.syncSale(edited);
      changed++;
    } catch (error) { this.logger.error(`[site-sales] telefone em ${sale.id}: ${error.message}`); }
  }
  await this.store.setConfig(this.guildId, 'siteSaleClientsPhone', true);
  this.logger.log(`[site-sales] ${changed} venda(s) do site agora mostram o telefone do cliente.`);
  return changed;
};

module.exports = { SiteSales, formatPhone };

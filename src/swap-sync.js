'use strict';

const crypto = require('crypto');
const { TOOL_ID_TO_NAME } = require('./catalog-sync');

// =============================================================================
// Trocas de conta feitas pela Central de atendimento (site, tabela account_swaps)
// refletidas na venda do Discord:
//   - venda do site/WhatsApp (avulsa, sem conta do bot): registro de TROCA + login novo na venda;
//   - venda do /vender (conta do estoque do bot): troca da conta da venda (replaceSaleAccount).
// Venda do site ainda não registrada no Discord: a troca espera a próxima rodada.
// =============================================================================

const digits = (v) => String(v || '').replace(/\D/g, '');
const samePhone = (a, b) => { const x = digits(a), y = digits(b); return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10); };
const WAIT_SALE_MS = 24 * 3600_000;

class SwapSync {
  constructor({ pool, store, guildId, siteKey, siteSync = null, logger = console }) {
    Object.assign(this, { pool, store, guildId, siteSync, logger });
    this.siteKey = siteKey && /^[a-fA-F0-9]{64}$/.test(siteKey) ? Buffer.from(siteKey, 'hex') : null;
  }

  _decrypt(data) {
    const b = Buffer.from(data, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.siteKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const raw = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    try { const v = JSON.parse(raw); return { login: String(v.login || ''), password: String(v.password || '') }; } catch {}
    return { login: (raw.match(/^Login:\s*(.*)$/im) || [])[1] || '', password: (raw.match(/^Senha:\s*(.*)$/im) || [])[1] || '' };
  }

  async _finish(id, status, fields = {}) {
    await this.pool.query(
      `UPDATE account_swaps SET discord_status = $2, discord_record = $3, discord_error = $4, discord_at = now() WHERE id = $1`,
      [id, status, fields.record || null, fields.error ? String(fields.error).slice(0, 500) : null]);
    if (status === 'error') {
      await this.pool.query(`INSERT INTO notifications (type, message, metadata) VALUES ('account.swap_discord_error', $1, $2::jsonb)`,
        [`Troca de conta não registrada no Discord: ${fields.error}`, JSON.stringify({ swapId: id })]).catch(() => {});
    }
  }

  // Venda do Discord desta troca: a do pedido do site, ou a venda ativa mais recente do mesmo telefone e ferramenta.
  async _findSale(swap, tool) {
    // A Central escolheu a venda exata (histórico de compras do cliente).
    if (swap.discord_sale_id) return { sale: await this.store.getRecord(this.guildId, 'vendas', swap.discord_sale_id) };
    if (swap.order_id) {
      const { rows } = await this.pool.query('SELECT order_code, discord_sale_id FROM orders WHERE id = $1', [swap.order_id]);
      const ref = rows[0]?.discord_sale_id;
      if (ref && /^VEN-/i.test(ref)) return { sale: await this.store.getRecord(this.guildId, 'vendas', ref), orderCode: rows[0].order_code };
      if (!ref) return { wait: true, orderCode: rows[0]?.order_code };
      // 'sincronizado-manual' e afins: a equipe lançou a venda à mão — procura pelo telefone.
    }
    const sales = (await this.store.listRecords(this.guildId, 'vendas'))
      .filter(s => s.tool === tool && samePhone(s.client, swap.phone) && s.status !== 'released')
      .sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt));
    return { sale: sales.find(s => s.status === 'active') || sales[0] || null };
  }

  // Uma vez só: as vendas já registradas passam a levar o login para o painel do site
  // (histórico de compras do cliente na Central).
  async backfillLogins() {
    if (!this.siteSync || await this.store.getConfig(this.guildId, 'siteSaleLoginsSynced', false)) return 0;
    const sales = await this.store.listRecords(this.guildId, 'vendas');
    for (const sale of sales) await this.siteSync.syncSale(sale);
    await this.store.setConfig(this.guildId, 'siteSaleLoginsSynced', true);
    this.logger.log(`[troca] ${sales.length} venda(s) reenviadas ao painel do site com o login.`);
    return sales.length;
  }

  async run() {
    if (!this.pool || !this.siteKey) return 0;
    await this.backfillLogins().catch(error => this.logger.error(`[troca] login nas vendas: ${error.message}`));
    const { rows } = await this.pool.query(`SELECT * FROM account_swaps WHERE discord_status = 'pending' ORDER BY id LIMIT 10`).catch((e) => {
      if (/account_swaps/.test(e.message)) return { rows: [] };   // tabela ainda não criada no site
      throw e;
    });
    let done = 0;
    for (const swap of rows) {
      try {
        const tool = TOOL_ID_TO_NAME[swap.tool_id];
        if (!tool) { await this._finish(swap.id, 'skipped', { error: `Ferramenta ${swap.tool_id} sem correspondente no bot.` }); continue; }
        const { sale, wait, orderCode } = await this._findSale(swap, tool);
        if (wait) {
          if (Date.now() - new Date(swap.created_at).getTime() > WAIT_SALE_MS) await this._finish(swap.id, 'error', { error: `Pedido ${orderCode} nunca virou venda no Discord.` });
          continue;
        }
        if (!sale) { await this._finish(swap.id, 'error', { error: `Nenhuma venda de ${tool} do cliente ${swap.phone || '(sem telefone)'} no Discord — registre a troca com /troca.` }); continue; }
        const creds = this._decrypt(swap.new_credentials);
        const reason = swap.reason || 'Conta parou de funcionar (troca pela Central de atendimento)';
        const registeredAt = new Date(swap.created_at).toISOString();
        let recordId;
        if (sale.oneTime) {
          const trade = await this.store.createTrade(this.guildId, {
            client: sale.client, tool, saleId: sale.id, login: creds.login, previousLogin: swap.old_login || undefined,
            reason, observation: `${orderCode || sale.siteOrder ? `Pedido ${orderCode || sale.siteOrder} · ` : ''}${swap.old_login || '?'} → ${creds.login} (${swap.mode === 'auto' ? 'automática' : 'manual'})`,
            registeredAt, actorId: 'central',
          });
          const edited = await this.store.editSale(this.guildId, { saleId: sale.id, changes: { login: creds.login }, actorId: 'central', editedAt: registeredAt });
          await this.siteSync?.syncSale(edited);
          recordId = trade.id;
        } else {
          const trade = await this.store.replaceSaleAccount(this.guildId, {
            saleId: sale.id, login: creds.login, password: creds.password, reason, registeredAt, actorId: 'central',
            observation: `Troca pela Central (${swap.mode === 'auto' ? 'automática' : 'manual'})`,
          });
          await this.siteSync?.syncSale(await this.store.getRecord(this.guildId, 'vendas', sale.id));
          recordId = trade.id;
        }
        await this._finish(swap.id, 'done', { record: recordId });
        this.logger.log(`[troca] ${sale.id}: ${swap.old_login || '?'} → ${creds.login} (${recordId})`);
        done++;
      } catch (error) {
        this.logger.error(`[troca] account_swaps #${swap.id}: ${error.message}`);
        await this._finish(swap.id, 'error', { error: error.message }).catch(() => {});
      }
    }
    return done;
  }
}

module.exports = { SwapSync, samePhone };

const zoompag = require('../../zoompag');

function upper(v) { return String(v || '').trim().toUpperCase(); }

function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    const keys = p.split('.');
    for (const k of keys) {
      if (!cur || typeof cur !== 'object') break;
      if (/^\d+$/.test(k) && Array.isArray(cur)) {
        const idx = parseInt(k, 10);
        if (idx < 0 || idx >= cur.length) break;
        cur = cur[idx];
      } else if (k in cur) {
        cur = cur[k];
      } else {
        break;
      }
    }
    if (cur != null) return cur;
  }
  return null;
}

module.exports = {
  id: 'zoompag',
  async createPix({ amount, external_id, payer, meta }) {
    const amountInCents = Math.round(amount * 100);
    const payload = {
      amount: amountInCents,  // cents
      method: 'PIX',
      customer: {
        name: payer?.name || 'Cliente',
        email: payer?.email || 'cliente@example.com',
        phone: payer?.phone || undefined,
        documentType: payer?.documentType || 'CPF',
        document: payer?.document || undefined,
      },
      items: [
        {
          title: meta?.offer_title || 'Pagamento',
          amount: amountInCents,
          quantity: 1,
          tangible: false,
          externalRef: external_id || undefined,
        }
      ]
    };
    const response = await zoompag.createPixCharge(payload);
    const data = response.data || {};  // baseado no exemplo
    const transaction_id = data.id || null;
    const status = data.status || 'PENDING';
    const qrcode = pick(data, ['pix.copyPaste']) || null;  // copia-cola do exemplo
    return {
      provider: 'zoompag',
      external_id,
      transaction_id,
      status,
      qrcode,
      raw: response,
    };
  },
  normalizeWebhook(payload) {
    const data = payload.data || payload;  // assumido
    const transaction_id = pick(data, ['id']) || null;
    const external_id = pick(data, ['items[0].externalRef', 'externalRef']) || null;
    const status = pick(data, ['status']) || null;
    const total = pick(data, ['amount']);
    const end_to_end = pick(data, ['pix.end2endId', 'end2endId', 'pix.endToEnd']) || null;
    return {
      transaction_id,
      external_id,
      status,
      total: total != null ? Number(total) : null,
      end_to_end,
      raw: payload,
    };
  },
  isPaidStatus(status) {
    const st = upper(status);
    return st === 'PAID' || st === 'COMPLETED';
  },
};
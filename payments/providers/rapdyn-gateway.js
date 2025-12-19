// payments/providers/rapdyn-gateway.js
const rapdyn = require('../../rapdyn');

function upper(v) {
  return String(v || '').trim().toUpperCase();
}

function pick(obj, paths) {
  for (const p of paths) {
    const parts = String(p).split('.');
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (!cur || typeof cur !== 'object' || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur != null) return cur;
  }
  return null;
}

function toCents(amountBRL) {
  const n = Number(amountBRL);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function docTypeAndValue(rawDoc) {
  const digits = String(rawDoc || '').replace(/\D/g, '');
  if (!digits) return { type: 'CPF', value: '' };
  return { type: digits.length > 11 ? 'CNPJ' : 'CPF', value: digits };
}

function isDataImage(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.startsWith('data:image/');
}

module.exports = {
  id: 'rapdyn',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    // DOC: POST https://app.rapdyn.io/api/payments
    const amountCents = toCents(amount);

    const doc = docTypeAndValue(payer?.document);
    const phone = String(payer?.phone || '').trim();

    const payload = {
      amount: amountCents,
      method: 'pix',
      external_id: external_id || undefined,
      customer: {
        name: payer?.name || 'Cliente',
        email: payer?.email || 'cliente@teste.com',
        phone: phone || undefined,
        document: {
          type: doc.type,
          value: doc.value,
        },
      },
      products: [
        {
          name: meta?.offer_title || meta?.product_name || 'Pagamento',
          price: amountCents,
          quantity: '1',
          type: 'digital',
        }
      ],
    };

    const data = await rapdyn.createPixCharge(payload);

    // campos principais
    const transaction_id = pick(data, ['id', 'transaction_id', 'transactionId', 'data.id']) || null;
    const status = pick(data, ['status', 'data.status']) || 'pending';

    // ✅ COPIA E COLA CORRETO (conforme seu log): pix.copypaste
    // fallback: tenta nomes comuns, mas evita data:image
    let qrcode = pick(data, [
      'pix.copypaste',      // ✅ confirmado
      'pix.copyPaste',
      'pix.copy_and_paste',
      'pix.emv',
      'pix.code',
      'emv',
      'qrcode',
      'data.pix.copypaste',
      'data.pix.emv',
      'data.emv',
      'data.qrcode',
    ]) || null;

    if (qrcode && isDataImage(qrcode)) {
      // se por algum motivo caiu no campo imagem, descarta
      qrcode = null;
    }

    return {
      provider: 'rapdyn',
      external_id,
      transaction_id,
      status: String(status),
      qrcode: qrcode ? String(qrcode) : null, // aqui vai o copia e cola
      raw: data,
    };
  },

  normalizeWebhook(payload) {
    // DOC webhook:
    // { notification_type:'transaction', id:'...', total:10000, method:'pix', status:'paid', external_id:'...', pix:{end2EndId}, ... }
    const transaction_id = pick(payload, ['id']) || null;
    const external_id = pick(payload, ['external_id']) || null;
    const status = pick(payload, ['status']) || null;

    const total = pick(payload, ['total']);
    const end2end = pick(payload, ['pix.end2EndId', 'pix.end2EndID', 'pix.end_to_end', 'pix.e2e']);

    const platform_tax = pick(payload, ['platform_tax']);
    const transaction_tax = pick(payload, ['transaction_tax']);
    const security_reserve_tax = pick(payload, ['security_reserve_tax']);
    const comission = pick(payload, ['comission']);

    return {
      transaction_id: transaction_id ? String(transaction_id) : null,
      external_id: external_id ? String(external_id) : null,
      status: status ? String(status) : null,
      total: total != null ? Number(total) : null,
      end_to_end: end2end ? String(end2end) : null,
      platform_tax: platform_tax != null ? Number(platform_tax) : null,
      transaction_tax: transaction_tax != null ? Number(transaction_tax) : null,
      security_reserve_tax: security_reserve_tax != null ? Number(security_reserve_tax) : null,
      comission: comission != null ? Number(comission) : null,
      raw: payload || null,
    };
  },

  isPaidStatus(status) {
    const st = upper(status);
    // doc: processing, pending, paid, failed, returned, cancelled, blocked, med
    return st === 'PAID' || st === 'COMPLETED' || st === 'CONFIRMED' || st === 'SUCCESS' || st === 'APPROVED';
  },
};

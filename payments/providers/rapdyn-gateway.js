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
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function inferDocType(docDigits) {
  const d = String(docDigits || '').replace(/\D/g, '');
  if (d.length === 14) return 'CNPJ';
  return 'CPF'; // padrão Brasil
}

function normalizePhone(phone) {
  // doc aceita string; manda só dígitos pra evitar rejeição
  const p = String(phone || '').replace(/\D/g, '');
  return p || '';
}

module.exports = {
  id: 'rapdyn',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    // Doc: amount em centavos + method pix + customer + products (+ delivery se physical)
    const amount_cents = toCents(amount);

    const docValue = String(payer?.document || '').replace(/\D/g, '');
    const docType = inferDocType(docValue);

    const productName =
      String(meta?.product_name || meta?.productName || meta?.offer_title || '').trim() ||
      'Produto';

    const productType = upper(meta?.product_type || meta?.productType || 'digital').toLowerCase();
    const isPhysical = productType === 'physical';

    const customer = {
      name: String(payer?.name || '').trim() || 'Cliente',
      email: String(payer?.email || '').trim(),
      phone: normalizePhone(payer?.phone),
      document: {
        type: docType,
        value: docValue,
      },
    };

    const products = [
      {
        name: productName,
        price: amount_cents,
        quantity: 1,
        type: isPhysical ? 'physical' : 'digital',
      },
    ];

    // delivery: na doc é obrigatório se tiver physical
    // A doc que você colou tem inconsistência (district/postal_code vs neighborhood/zipcode),
    // então mandamos o padrão do EXEMPLO e duplicamos chaves equivalentes pra compatibilidade.
    let delivery = undefined;
    if (isPhysical) {
      const d = meta?.delivery || {};
      const street = String(d.street || '').trim();
      const number = String(d.number || '').trim();
      const neighborhood = String(d.neighborhood || d.district || '').trim();
      const city = String(d.city || '').trim();
      const state = String(d.state || '').trim();
      const zipcode = String(d.zipcode || d.postal_code || '').replace(/\D/g, '');

      if (!street || !number || !neighborhood || !city || !state || !zipcode) {
        const e = new Error('Rapdyn: delivery obrigatório para produto physical.');
        e.code = 'RAPDYN_VALIDATION';
        e.meta = { missing_delivery: true };
        throw e;
      }

      delivery = {
        street,
        number,
        complement: d.complement ? String(d.complement).trim() : undefined,

        // exemplo
        neighborhood,
        city,
        state,
        zipcode,

        // compat com a tabela (caso o backend espere esses nomes)
        district: neighborhood,
        postal_code: zipcode,
        country: d.country ? String(d.country).trim() : undefined,
      };
    }

    const payload = {
      amount: amount_cents,
      method: 'pix',
      external_id: external_id || undefined,
      customer,
      ...(delivery ? { delivery } : {}),
      products,
    };

    // chama Rapdyn
    const data = await rapdyn.createPayment(payload);

    // Response não está na doc que você colou, então continua flexível:
    const transaction_id = pick(data, [
      'transaction_id', 'transactionId', 'id', 'data.id', 'payment.id',
    ]) || null;

    const status = pick(data, [
      'status', 'data.status', 'payment.status',
    ]) || 'PENDING';

    // “copia e cola” costuma vir como emv / qrcode / pix.emv etc
    const qrcode = pick(data, [
      'qrcode', 'qr_code', 'qrCode',
      'emv', 'pix.emv', 'data.pix.emv',
      'data.qrcode', 'data.emv',
      'payment.qrcode', 'payment.emv',
    ]) || null;

    return {
      provider: 'rapdyn',
      external_id,
      transaction_id,
      status: String(status),
      qrcode: qrcode ? String(qrcode) : null,
      raw: data,
    };
  },

  normalizeWebhook(payload) {
    // Webhook não está na doc que você colou (precisa do formato real depois).
    const transaction_id = pick(payload, ['transaction_id', 'transactionId', 'id', 'data.id', 'payment.id']) || null;
    const external_id = pick(payload, ['external_id', 'externalId', 'reference', 'ref', 'data.external_id']) || null;
    const status = pick(payload, ['status', 'data.status', 'payment.status']) || null;

    const feeRaw = pick(payload, ['fee', 'data.fee']);
    const netRaw = pick(payload, ['net_amount', 'netAmount', 'data.net_amount']);
    const e2e = pick(payload, ['end_to_end', 'endToEnd', 'e2e', 'data.end_to_end']);

    const fee = feeRaw != null ? Number(feeRaw) : null;
    const net_amount = netRaw != null ? Number(netRaw) : null;

    return {
      transaction_id,
      external_id,
      status: status ? String(status) : null,
      fee: Number.isFinite(fee) ? fee : null,
      net_amount: Number.isFinite(net_amount) ? net_amount : null,
      end_to_end: e2e ? String(e2e) : null,
    };
  },

  isPaidStatus(status) {
    const st = upper(status);
    return st === 'PAID' || st === 'COMPLETED' || st === 'CONFIRMED' || st === 'SUCCESS' || st === 'APPROVED';
  },
};

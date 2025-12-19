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

module.exports = {
  id: 'rapdyn',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    // AJUSTE payload conforme doc Rapdyn:
    // - nomes comuns: amount/value, external_id/reference, webhook_url/callback_url, payer fields, etc.
    const payload = {
      amount,
      external_id,
      callback_url: callbackUrl,
      payer: {
        name: payer?.name,
        email: payer?.email,
        document: payer?.document,
        phone: payer?.phone || undefined,
      },
      meta: meta || undefined,
    };

    const data = await rapdyn.createPixCharge(payload);

    // Tentativas de extrair campos “comuns” (ajuste conforme doc real)
    const transaction_id = pick(data, [
      'transaction_id',
      'transactionId',
      'id',
      'data.id',
      'charge.id',
      'pix.id',
    ]) || null;

    const status = pick(data, [
      'status',
      'data.status',
      'charge.status',
      'pix.status',
    ]) || 'PENDING';

    const qrcode = pick(data, [
      'qrcode',
      'qr_code',
      'qrCode',
      'pix.qrcode',
      'pix.emv',
      'data.pix.emv',
      'data.qrcode',
      'data.emv',
      'emv',
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
    // AJUSTE conforme doc Rapdyn webhook:
    const transaction_id = pick(payload, ['transaction_id', 'transactionId', 'id', 'data.id', 'charge.id']) || null;
    const external_id = pick(payload, ['external_id', 'externalId', 'reference', 'ref', 'data.external_id']) || null;
    const status = pick(payload, ['status', 'data.status', 'charge.status']) || null;

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

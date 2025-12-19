// payments/providers/veltrax-gateway.js
const veltrax = require('../../veltrax');

function upper(v) {
  return String(v || '').trim().toUpperCase();
}

module.exports = {
  id: 'veltrax',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    const payload = {
      amount,
      external_id,
      clientCallbackUrl: callbackUrl,
      payer: {
        name: payer?.name,
        email: payer?.email,
        document: payer?.document,
        phone: payer?.phone || undefined,
      },
      meta: meta || undefined,
    };

    const data = await veltrax.createDeposit(payload);

    const transaction_id = data?.qrCodeResponse?.transactionId || data?.transactionId || null;
    const status = data?.qrCodeResponse?.status || data?.status || 'PENDING';
    const qrcode = data?.qrCodeResponse?.qrcode || data?.qrcode || null;

    return {
      provider: 'veltrax',
      external_id,
      transaction_id,
      status: String(status),
      qrcode,
      raw: data,
    };
  },

  normalizeWebhook(payload) {
    const transaction_id = payload?.transaction_id || payload?.transactionId || null;
    const external_id = payload?.external_id || payload?.externalId || null;
    const status = payload?.status || null;

    const fee = payload?.fee != null ? Number(payload.fee) : null;
    const net_amount =
      payload?.net_amount != null ? Number(payload.net_amount)
        : (payload?.net_amout != null ? Number(payload.net_amout) : null);

    const end_to_end = payload?.end_to_end || payload?.endToEnd || null;

    return {
      transaction_id,
      external_id,
      status: status ? String(status) : null,
      fee: Number.isFinite(fee) ? fee : null,
      net_amount: Number.isFinite(net_amount) ? net_amount : null,
      end_to_end,
    };
  },

  isPaidStatus(status) {
    const st = upper(status);
    return st === 'COMPLETED' || st === 'PAID' || st === 'CONFIRMED' || st === 'SUCCESS';
  },
};

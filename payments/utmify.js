const axios = require('axios');

function getUtmifyApiToken() {
  return String(global.botSettings?.utmify_api_token || '').trim();
}

function formatDateUTC(ts) {
  const d = new Date(ts || Date.now());
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

async function sendToUtmify(status, data) {
  const token = getUtmifyApiToken();
  if (!token) {
    console.log('[UTMIFY][SKIP] Missing api token.');
    return { ok: false, reason: 'missing-token' };
  }

  const amountCents = Math.round(data.amount * 100);
  const createdAt = formatDateUTC(data.createdAt || Date.now());
  const approvedDate = (status === 'paid') ? formatDateUTC(Date.now()) : null;

  const payload = {
    orderId: data.external_id,
    platform: 'BotProjeto',
    paymentMethod: 'pix',
    status,
    createdAt,
    approvedDate,
    refundedAt: null,
    customer: {
      name: data.payer_name || 'Cliente',
      email: data.payer_email || 'cliente@teste.com',
      phone: data.payer_phone || null,
      document: data.payer_document || null,
      country: 'BR',
      ip: null,
    },
    products: [
      {
        id: data.offer_id || 'default',
        name: data.offer_title || 'Pagamento',
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: amountCents,
      }
    ],
    trackingParameters: {
      src: null,
      sck: null,
      utm_source: null,
      utm_campaign: null,
      utm_medium: null,
      utm_content: null,
      utm_term: null,
    },
    commission: {
      totalPriceInCents: amountCents,
      gatewayFeeInCents: 0, // adjust if known
      userCommissionInCents: amountCents,
      currency: 'BRL',
    },
    isTest: true, // start with true, change to false in production
  };

  try {
    await axios.post('https://api.utmify.com.br/api-credentials/orders', payload, {
      headers: {
        'x-api-token': token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    console.log(`[UTMIFY][SEND][OK] ${status}`, { orderId: data.external_id });
    return { ok: true };
  } catch (e) {
    console.error(`[UTMIFY][SEND][ERROR] ${status}`, {
      orderId: data.external_id,
      code: e?.code,
      status: e?.response?.status,
      data: e?.response?.data,
      message: e?.message,
    });
    return { ok: false, error: e };
  }
}

module.exports = { sendToUtmify };

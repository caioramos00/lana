'use strict';

const axiosLib = require('axios');

function formatDateUTC(ts) {
  const d = new Date(ts || Date.now());
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function buildPayload(status, data, { platform = 'lana', isTest = false } = {}) {
  const amount = Number(data?.amount || 0);
  const amountCents = Math.round(amount * 100);

  const createdAt = formatDateUTC(data?.createdAt || Date.now());
  const approvedDate = (String(status).toLowerCase() === 'paid') ? formatDateUTC(Date.now()) : null;

  return {
    orderId: data?.external_id,
    platform,
    paymentMethod: 'pix',
    status,
    createdAt,
    approvedDate,
    refundedAt: null,
    customer: {
      name: data?.payer_name || 'Cliente',
      email: data?.payer_email || 'cliente@teste.com',
      phone: data?.payer_phone || null,
      document: data?.payer_document || null,
      country: 'BR',
      ip: '0.0.0.0',
    },
    products: [
      {
        id: data?.offer_id || 'default',
        name: data?.offer_title || 'Pagamento',
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
      gatewayFeeInCents: 0,
      userCommissionInCents: amountCents,
      currency: 'BRL',
    },
    isTest,
  };
}

function createUtmifyClient({
  axios,
  getToken,
  logger = console,
  endpoint = 'https://api.utmify.com.br/api-credentials/orders',
  platform = 'BotProjeto',
  isTest = false,
  timeout = 30000,
} = {}) {
  if (!axios) throw new Error('[utmify] axios is required');
  if (!getToken) throw new Error('[utmify] getToken is required');

  async function send(status, data) {
    const token = String(await getToken() || '').trim();
    if (!token) {
      logger.log('[UTMIFY][SKIP] Missing api token.');
      return { ok: false, reason: 'missing-token' };
    }

    const payload = buildPayload(status, data, { platform, isTest });

    if (!payload.orderId) {
      logger.error('[UTMIFY][SEND][ERROR] missing external_id (orderId).', {
        status,
        external_id: data?.external_id,
      });
      return { ok: false, reason: 'missing-order-id' };
    }

    try {
      await axios.post(endpoint, payload, {
        headers: {
          'x-api-token': token,
          'Content-Type': 'application/json',
        },
        timeout,
      });

      logger.log(`[UTMIFY][SEND][OK] ${status}`, { orderId: payload.orderId });
      return { ok: true };
    } catch (e) {
      logger.error(`[UTMIFY][SEND][ERROR] ${status}`, {
        orderId: payload.orderId,
        code: e?.code,
        status: e?.response?.status,
        data: e?.response?.data,
        message: e?.message,
      });
      return { ok: false, error: e };
    }
  }

  return { send };
}

async function sendToUtmify(status, data) {
  const client = createUtmifyClient({
    axios: axiosLib,
    getToken: async () => String(global?.botSettings?.utmify_api_token || '').trim(),
    logger: console,
  });

  return client.send(status, data);
}

module.exports = {
  createUtmifyClient,
  sendToUtmify,
};

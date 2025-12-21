'use strict';

function formatDateUTC(ts) {
  const d = new Date(ts || Date.now());
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function createUtmifyClient({ axios, getToken, logger = console } = {}) {
  if (!axios) throw new Error('[utmify] axios is required');
  if (!getToken) throw new Error('[utmify] getToken is required');

  async function send(status, data) {
    const token = String(await getToken() || '').trim();
    if (!token) {
      logger.log('[UTMIFY][SKIP] Missing api token.');
      return { ok: false, reason: 'missing-token' };
    }

    const amount = Number(data?.amount || 0);
    const amountCents = Math.round(amount * 100);

    const createdAt = formatDateUTC(data?.createdAt || Date.now());
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
        ip: '0.0.0.0',
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
        gatewayFeeInCents: 0,
        userCommissionInCents: amountCents,
        currency: 'BRL',
      },
      isTest: false,
    };

    try {
      await axios.post('https://api.utmify.com.br/api-credentials/orders', payload, {
        headers: {
          'x-api-token': token,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      logger.log(`[UTMIFY][SEND][OK] ${status}`, { orderId: data.external_id });
      return { ok: true };
    } catch (e) {
      logger.error(`[UTMIFY][SEND][ERROR] ${status}`, {
        orderId: data.external_id,
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

module.exports = { createUtmifyClient };

'use strict';

const axiosLib = require('axios');

function formatDateUTC(ts) {
  const d = new Date(ts || Date.now());
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pickMetaAds(data) {
  return data?.meta_ads || data?.metaAds || data?.ads_lookup || data?.adsLookup || null;
}

/**
 * Deriva trackingParameters pro Utmify.
 * Prioridade:
 * 1) data.trackingParameters (se já vier pronto, sobrescreve)
 * 2) data.meta_ads (lookup da Graph API)
 * 3) fallback nulls
 */
function deriveTrackingParameters(data) {
  const base = {
    src: null,
    sck: null,
    utm_source: null,
    utm_campaign: null,
    utm_medium: null,
    utm_content: null,
    utm_term: null,
  };

  const metaAds = pickMetaAds(data);

  // se veio meta_ads (Graph API), preenche com ele
  if (metaAds) {
    const referral = metaAds?.referral || null;
    const ids = metaAds?.ids || null;

    // escolhas práticas (você pode mudar depois se quiser outro mapeamento)
    // - src: "meta"
    // - sck: ctwa_clid (identificador do click-to-whatsapp)
    // - utm_*: nomes (com fallback para IDs)
    base.src = 'meta';
    base.sck = toStrOrNull(referral?.ctwa_clid);

    base.utm_source = 'meta';
    base.utm_medium = 'cpc';

    base.utm_campaign = toStrOrNull(metaAds?.campaign_name) || toStrOrNull(ids?.campaign_id);
    base.utm_content = toStrOrNull(metaAds?.ad_name) || toStrOrNull(ids?.ad_id);
    base.utm_term = toStrOrNull(metaAds?.adset_name) || toStrOrNull(ids?.adset_id);
  }

  // se o caller já mandou trackingParameters, ele tem precedência
  const override = data?.trackingParameters && typeof data.trackingParameters === 'object'
    ? data.trackingParameters
    : null;

  if (override) {
    return {
      ...base,
      ...Object.fromEntries(
        Object.entries(override).map(([k, v]) => [k, toStrOrNull(v)])
      ),
    };
  }

  return base;
}

function buildPayload(status, data, { platform = 'lana', isTest = false } = {}) {
  const amount = Number(data?.amount || 0);
  const amountCents = Math.round(amount * 100);

  const createdAt = formatDateUTC(data?.createdAt || Date.now());
  const approvedDate = (String(status).toLowerCase() === 'paid') ? formatDateUTC(Date.now()) : null;

  const trackingParameters = deriveTrackingParameters(data);

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
    trackingParameters,
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

    // ✅ log do tracking (sem vazar token)
    try {
      logger.log('[UTMIFY][TRACKING]', {
        orderId: payload.orderId,
        src: payload?.trackingParameters?.src,
        sck: payload?.trackingParameters?.sck ? String(payload.trackingParameters.sck).slice(0, 12) + '…' : null,
        utm_source: payload?.trackingParameters?.utm_source,
        utm_campaign: payload?.trackingParameters?.utm_campaign,
        utm_content: payload?.trackingParameters?.utm_content,
        utm_term: payload?.trackingParameters?.utm_term,
      });
    } catch {}

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

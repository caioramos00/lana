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

function sanitizeLabel(v, maxLen = 80) {
  const s = String(v || '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function labelId(label, id) {
  const l = sanitizeLabel(label);
  const i = toStrOrNull(id);
  if (l && i) return `${l}|${i}`;
  return l || i || null;
}

function parseQueryString(qs) {
  const raw = String(qs || '').trim();
  if (!raw) return {};
  const s = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(s);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function expandMetaMacros(template, metaAds) {
  const t = String(template || '').trim();
  if (!t) return null;

  const ids = metaAds?.ids || null;
  const referral = metaAds?.referral || null;

  const dict = {
    'campaign.id': ids?.campaign_id,
    'adset.id': ids?.adset_id,
    'ad.id': ids?.ad_id,
    'account.id': ids?.account_id,
    'creative.id': ids?.creative_id,

    'campaign.name': metaAds?.campaign_name,
    'adset.name': metaAds?.adset_name,
    'ad.name': metaAds?.ad_name,

    'ctwa_clid': referral?.ctwa_clid,
    // se algum dia você adicionar placement ao meta_ads, já fica pronto
    'placement': metaAds?.placement || null,
  };

  const replaced = t.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    const k = String(key || '').trim();
    const v = dict[k];
    return v == null ? '' : String(v);
  });

  const out = replaced.trim();
  return out ? out : null;
}

function buildTrackingFromCreativeUrlTags(metaAds) {
  const urlTags = metaAds?.creative_url_tags || null;
  if (!urlTags) return null;

  const parsed = parseQueryString(urlTags);
  if (!parsed || typeof parsed !== 'object') return null;

  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    const expanded = expandMetaMacros(v, metaAds);
    out[k] = expanded;
  }
  return out;
}

/**
 * Deriva trackingParameters pro Utmify.
 * Prioridade:
 * 1) data.trackingParameters (override do caller)
 * 2) url_tags do AdCreative (se existir)
 * 3) fallback usando nomes + IDs (campaign/adset/ad)
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

  if (metaAds) {
    const ids = metaAds?.ids || null;
    const referral = metaAds?.referral || null;

    // 2) tenta vir do creative.url_tags (UTMs reais configurados no Meta)
    const tags = buildTrackingFromCreativeUrlTags(metaAds);

    base.src = toStrOrNull(tags?.src) || null;

    // ✅ sck: se vier no url_tags, usa. se não, ctwa_clid é o melhor substituto
    base.sck = toStrOrNull(tags?.sck) || toStrOrNull(referral?.ctwa_clid) || null;

    // ✅ utm_source: se veio do anúncio, respeita; senão padroniza FB (igual exemplos da doc)
    base.utm_source = toStrOrNull(tags?.utm_source) || 'FB';

    // ✅ campanha/conjunto/anúncio: se veio do anúncio, respeita; senão monta NOME|ID
    base.utm_campaign =
      toStrOrNull(tags?.utm_campaign)
      || labelId(metaAds?.campaign_name, ids?.campaign_id);

    base.utm_medium =
      toStrOrNull(tags?.utm_medium)
      || labelId(metaAds?.adset_name, ids?.adset_id);

    base.utm_content =
      toStrOrNull(tags?.utm_content)
      || labelId(metaAds?.ad_name, ids?.ad_id);

    // ✅ placement/term: só se vier, senão null (doc permite null)
    base.utm_term =
      toStrOrNull(tags?.utm_term)
      || toStrOrNull(tags?.placement)
      || null;
  }

  // 1) override do caller (maior prioridade)
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

    // ✅ log do tracking
    try {
      logger.log('[UTMIFY][TRACKING]', {
        orderId: payload.orderId,
        src: payload?.trackingParameters?.src,
        sck: payload?.trackingParameters?.sck ? String(payload.trackingParameters.sck).slice(0, 12) + '…' : null,
        utm_source: payload?.trackingParameters?.utm_source,
        utm_campaign: payload?.trackingParameters?.utm_campaign,
        utm_medium: payload?.trackingParameters?.utm_medium,
        utm_content: payload?.trackingParameters?.utm_content,
        utm_term: payload?.trackingParameters?.utm_term,
      });
    } catch { }

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

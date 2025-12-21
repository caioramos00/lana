const DEFAULT_API_VERSION = 'v23.0';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  try {
    // opcional: se você já tiver node-fetch instalado
    // eslint-disable-next-line global-require
    return require('node-fetch');
  } catch (e) {
    throw new Error('meta_ads.js: fetch não disponível (use Node 18+ ou instale node-fetch).');
  }
}

function normalizeVersion(v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return DEFAULT_API_VERSION;
  // aceita "v20.0" ou "20.0" (normaliza para "v20.0")
  if (s.startsWith('v')) return s;
  return `v${s}`;
}

function clampInt(n, { min, max } = {}) {
  if (!Number.isFinite(n)) return null;
  let x = Math.trunc(n);
  if (Number.isFinite(min)) x = Math.max(min, x);
  if (Number.isFinite(max)) x = Math.min(max, x);
  return x;
}

function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function redactToken(t) {
  const s = (t || '').trim();
  if (!s) return '';
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function buildGraphUrl({ version, path, params }) {
  const v = normalizeVersion(version);
  const p = String(path || '').replace(/^\//, '');
  const url = new URL(`https://graph.facebook.com/${v}/${p}`);
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, val]) => {
    if (val === undefined || val === null) return;
    const s = String(val);
    if (!s.trim()) return;
    sp.set(k, s);
  });
  url.search = sp.toString();
  return url.toString();
}

async function graphGet({ accessToken, version, path, params, timeoutMs }) {
  const token = (accessToken || '').trim();
  if (!token) {
    const err = new Error('META_ADS_NO_TOKEN');
    err.code = 'META_ADS_NO_TOKEN';
    throw err;
  }

  const tmo = clampInt(toIntOrNull(timeoutMs), { min: 1000, max: 120000 }) ?? DEFAULT_TIMEOUT_MS;

  const url = buildGraphUrl({
    version,
    path,
    params: {
      ...params,
      access_token: token,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tmo);

  try {
    const fetchFn = getFetch();
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // deixa data como null
    }

    if (!res.ok || (data && data.error)) {
      const e = data?.error || {};
      const err = new Error(e.message || `Graph API error (${res.status})`);
      err.code = e.code || `HTTP_${res.status}`;
      err.type = e.type;
      err.subcode = e.error_subcode;
      err.fbtrace_id = e.fbtrace_id;
      err.status = res.status;
      err.url = url;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

// -------------------- cache --------------------

const _cache = new Map(); // key -> { exp, value }
const _inflight = new Map(); // key -> Promise

function cacheGet(key) {
  const it = _cache.get(key);
  if (!it) return null;
  if (it.exp && Date.now() > it.exp) {
    _cache.delete(key);
    return null;
  }
  return it.value;
}

function cacheSet(key, value, ttlMs) {
  const ttl = clampInt(toIntOrNull(ttlMs), { min: 0, max: 7 * 24 * 60 * 60 * 1000 }) ?? DEFAULT_CACHE_TTL_MS;
  if (ttl === 0) return; // desativado
  _cache.set(key, { value, exp: Date.now() + ttl });
}

async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit) return hit;
  if (_inflight.has(key)) return _inflight.get(key);

  const p = (async () => {
    const v = await fn();
    cacheSet(key, v, ttlMs);
    return v;
  })().finally(() => _inflight.delete(key));

  _inflight.set(key, p);
  return p;
}

// -------------------- API específica --------------------

async function getAd({ adId, cfg }) {
  const fields = 'id,name,adset_id,campaign_id,account_id,effective_status,status,created_time,updated_time';
  return cached(`ad:${adId}`, cfg.cacheTtlMs, () =>
    graphGet({
      accessToken: cfg.accessToken,
      version: cfg.apiVersion,
      path: adId,
      params: { fields },
      timeoutMs: cfg.timeoutMs,
    })
  );
}

async function getAdSet({ adsetId, cfg }) {
  const fields = 'id,name,campaign_id,account_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal';
  return cached(`adset:${adsetId}`, cfg.cacheTtlMs, () =>
    graphGet({
      accessToken: cfg.accessToken,
      version: cfg.apiVersion,
      path: adsetId,
      params: { fields },
      timeoutMs: cfg.timeoutMs,
    })
  );
}

async function getCampaign({ campaignId, cfg }) {
  const fields = 'id,name,objective,buying_type,effective_status,status,created_time,updated_time';
  return cached(`campaign:${campaignId}`, cfg.cacheTtlMs, () =>
    graphGet({
      accessToken: cfg.accessToken,
      version: cfg.apiVersion,
      path: campaignId,
      params: { fields },
      timeoutMs: cfg.timeoutMs,
    })
  );
}

/**
 * Resolve hierarquia por Ad ID (referral.source_id)
 * Retorna:
 * {
 *   ad: {...},
 *   adset: {...} | null,
 *   campaign: {...} | null,
 *   ids: { ad_id, adset_id, campaign_id, account_id },
 * }
 */
async function resolveHierarchyByAdId(adId, cfg) {
  if (!adId) return null;

  const ad = await getAd({ adId, cfg });

  const adsetId = ad?.adset_id || null;
  const campaignIdFromAd = ad?.campaign_id || null;

  let adset = null;
  let campaignId = campaignIdFromAd || null;

  if (adsetId) {
    adset = await getAdSet({ adsetId, cfg });
    if (!campaignId && adset?.campaign_id) campaignId = adset.campaign_id;
  }

  const campaign = campaignId ? await getCampaign({ campaignId, cfg }) : null;

  return {
    ad,
    adset,
    campaign,
    ids: {
      ad_id: ad?.id || String(adId),
      adset_id: adset?.id || adsetId || null,
      campaign_id: campaign?.id || campaignId || null,
      account_id: ad?.account_id || adset?.account_id || null,
    },
  };
}

/**
 * Extrai referral de várias formas (seu log tem referral no root e também em message.referral).
 */
function extractReferral(obj) {
  if (!obj) return null;
  const r1 = obj.referral || null;
  const r2 = obj.message?.referral || null;
  const r = r1 || r2;
  if (!r) return null;

  const sourceType = r.source_type || r.sourceType || null;
  const sourceId = r.source_id || r.sourceId || null;
  const ctwa = r.ctwa_clid || r.ctwaClid || null;

  return {
    source_type: sourceType,
    source_id: sourceId,
    ctwa_clid: ctwa,
    source_url: r.source_url || null,
    headline: r.headline || null,
    body: r.body || null,
    media_type: r.media_type || null,
    video_url: r.video_url || null,
  };
}

/**
 * Resolve dados de campanha a partir do seu evento inbound.
 * - Se não tiver referral/source_id ou source_type != 'ad' => null
 */
async function resolveCampaignFromInbound(inboundEvent, settings, { logger } = {}) {
  const log = logger || console;
  const referral = extractReferral(inboundEvent);
  if (!referral?.source_id) return null;

  // Só processa se for anúncio
  if (String(referral.source_type || '').toLowerCase() !== 'ad') return null;

  const token =
    (settings?.meta_ads_access_token || '').trim()
    || (settings?.graph_api_access_token || '').trim()
    || '';

  const cfg = {
    accessToken: token,
    apiVersion: normalizeVersion(settings?.meta_ads_api_version),
    timeoutMs: clampInt(toIntOrNull(settings?.meta_ads_timeout_ms), { min: 1000, max: 120000 }) ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: clampInt(toIntOrNull(settings?.meta_ads_cache_ttl_ms), { min: 0, max: 7 * 24 * 60 * 60 * 1000 }) ?? DEFAULT_CACHE_TTL_MS,
  };

  if (!cfg.accessToken) {
    log.warn?.('[META][ADS][SKIP] sem token (meta_ads_access_token / graph_api_access_token)', {
      ad_id: referral.source_id,
    });
    return null;
  }

  try {
    const hier = await resolveHierarchyByAdId(String(referral.source_id), cfg);

    const out = {
      referral,
      ids: hier?.ids || null,
      ad_name: hier?.ad?.name || null,
      adset_name: hier?.adset?.name || null,
      campaign_name: hier?.campaign?.name || null,
      campaign_objective: hier?.campaign?.objective || null,
      campaign_status: hier?.campaign?.effective_status || hier?.campaign?.status || null,
      debug: {
        apiVersion: cfg.apiVersion,
        timeoutMs: cfg.timeoutMs,
        cacheTtlMs: cfg.cacheTtlMs,
        token: redactToken(cfg.accessToken),
      },
    };

    return out;
  } catch (err) {
    log.warn?.('[META][ADS][ERROR]', {
      message: err?.message,
      code: err?.code,
      type: err?.type,
      subcode: err?.subcode,
      status: err?.status,
      fbtrace_id: err?.fbtrace_id,
      ad_id: referral.source_id,
      token: redactToken(cfg.accessToken),
    });
    return null;
  }
}

module.exports = {
  extractReferral,
  graphGet,
  resolveHierarchyByAdId,
  resolveCampaignFromInbound,
};

// payments/payment-module.js
'use strict';

const crypto = require('crypto');

function upper(v) { return String(v || '').trim().toUpperCase(); }

function sanitizeKey(v, maxLen = 28) {
  const s = String(v || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'fase';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function makeExternalId({ wa_id, extKey }) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(10).toString('hex');
  const key = sanitizeKey(extKey, 28);
  const wa = String(wa_id || '').replace(/\D/g, '').slice(-18) || 'wa';
  return `ord_${wa}_${key}_${ts}_${rand}`;
}

function parseWaIdFromExternalId(external_id) {
  const s = String(external_id || '').trim();
  const m = s.match(/^ord_(\d{6,18})_/);
  return m ? m[1] : null;
}

function short(v, n = 10) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function sleep(ms) {
  const t = Number(ms);
  return new Promise(r => setTimeout(r, Number.isFinite(t) ? Math.max(0, t) : 0));
}

function createPaymentsModule({
  db,
  lead,
  publishState,
  logger = console,
  axiosInstance,
} = {}) {
  if (!db) throw new Error('[payments] db is required');

  const axios = axiosInstance || require('axios');

  // Providers (plugins)
  const createProviders = require('./providers');
  const providers = createProviders({ axios, logger });

  // ✅ UTMify client (DI)
  const { createUtmifyClient } = require('./utmify');
  const utmify = createUtmifyClient({
    axios,
    logger,
    getToken: async () => {
      const settings = await db.getBotSettings();
      return String(settings?.utmify_api_token || '').trim();
    },
  });

  function normalizeProvider(id) {
    const p = String(id || '').trim().toLowerCase();
    return providers[p] ? p : null;
  }

  function pickProviderFromCtx(ctx, { offer } = {}) {
    const raw =
      ctx?.vars?.pix_gateway ||
      ctx?.vars?.gateway ||
      ctx?.agent?.pix_gateway ||
      ctx?.agent?.gateway ||
      (offer && offer.gateway) ||
      null;

    return normalizeProvider(raw);
  }

  function getDefaultProviderFromSettings(settings) {
    const raw = String(settings?.pix_gateway_default || '').trim().toLowerCase();
    return normalizeProvider(raw) || 'veltrax';
  }

  function buildCallbackUrl(provider, settings) {
    const p = normalizeProvider(provider) || getDefaultProviderFromSettings(settings);

    const map = {
      veltrax: {
        baseKey: 'veltrax_callback_base_url',
        pathKey: 'veltrax_webhook_path',
        defPath: '/webhook/veltrax',
      },
      rapdyn: {
        baseKey: 'rapdyn_callback_base_url',
        pathKey: 'rapdyn_webhook_path',
        defPath: '/webhook/rapdyn',
      },
      zoompag: {
        baseKey: 'zoompag_callback_base_url',
        pathKey: 'zoompag_webhook_path',
        defPath: '/webhook/zoompag',
      },
    };

    const cfg = map[p];
    if (!cfg) return null;

    const base = String(settings?.[cfg.baseKey] || '')
      .trim()
      .replace(/\/+$/, '');

    const path = String(settings?.[cfg.pathKey] || cfg.defPath)
      .trim() || cfg.defPath;

    if (!base) return null;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  // ✅ pega meta_ads do lead em memória (se existir)
  async function getMetaAdsForWa(wa_id, { waitMs = 2500 } = {}) {
    try {
      const st = lead?.getLead?.(wa_id);
      if (!st) return null;

      // já tem?
      if (st.meta_ads) return st.meta_ads;

      // às vezes você salva em last_ads_lookup também
      if (st.last_ads_lookup && !st.meta_ads) return st.last_ads_lookup;

      const inflight = st.meta_ads_inflight;

      // se o lookup está rodando, espera ele (com timeout)
      if (inflight && typeof inflight.then === 'function') {
        try {
          await Promise.race([inflight, sleep(waitMs)]);
        } catch { /* noop */ }
        return st.meta_ads || st.last_ads_lookup || null;
      }

      // fallback: pequena janela de polling caso não tenha inflight mas possa ser setado “já já”
      const until = Date.now() + (Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0);
      while (!st.meta_ads && !st.last_ads_lookup && Date.now() < until) {
        await sleep(80);
      }
      return st.meta_ads || st.last_ads_lookup || null;
    } catch {
      return null;
    }
  }

  async function createPixCharge({
    ctx,
    wa_id,
    offer_id,
    offer_title,
    amount,
    extKey,
    payer,
    providerHint,
    meta,
  }) {
    const settings = await db.getBotSettings();

    const provider =
      normalizeProvider(providerHint) ||
      pickProviderFromCtx(ctx, { offer: meta?.offer }) ||
      getDefaultProviderFromSettings(settings);

    const gw = providers[provider];
    if (!gw) throw new Error(`[payments] provider not found: ${provider}`);

    const callbackUrl = buildCallbackUrl(provider, settings);

    if (gw.requiresCallback && !callbackUrl) {
      return { ok: false, reason: 'missing-callback-url', provider };
    }

    let created = null;
    let external_id = null;
    let lastErr = null;

    for (let i = 0; i < 2; i++) {
      const extId = makeExternalId({ wa_id, extKey: extKey || offer_id || 'fase' });

      try {
        created = await gw.createPix({
          amount,
          external_id: extId,
          callbackUrl,
          payer,
          meta: {
            wa_id,
            offer_id,
            offer_title: offer_title || meta?.offer_title || 'Pagamento',
            ...meta,
          },
          settings,
          axios,
        });

        external_id = extId;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e?.http_status === 409 && i === 0) continue;
        break;
      }
    }

    if (!created) {
      logger.error('[PIX][CREATE][FAIL]', {
        wa_id,
        provider,
        offer_id,
        amount,
        code: lastErr?.code,
        http_status: lastErr?.http_status,
        request_id: lastErr?.request_id,
        message: lastErr?.message,
        response_data: lastErr?.response_data,
      });
      return {
        ok: false,
        reason: 'pix-create-error',
        provider,
        code: lastErr?.code || null,
        http_status: lastErr?.http_status || null,
        request_id: lastErr?.request_id || null,
        message: lastErr?.message || null,
      };
    }

    const transaction_id = created?.transaction_id || null;
    const status = String(created?.status || 'PENDING').trim() || 'PENDING';
    const qrcode = created?.qrcode || null;

    let row = null;
    try {
      row = await db.createPixDepositRow({
        provider,
        wa_id,
        offer_id: offer_id || null,
        amount,
        external_id,
        transaction_id,
        status,
        payer_name: payer?.name || 'Cliente',
        payer_email: payer?.email || 'cliente@teste.com',
        payer_document: payer?.document || null,
        payer_phone: payer?.phone || null,
        qrcode,
        raw_create_response: created?.raw || created || null,
      });
    } catch (e) {
      logger.warn('[PIX][DB][WARN] createPixDepositRow', { message: e?.message });
    }

    logger.log('[LEAD][STORE_ID][PIX]', lead?.__store_id, { wa_id });

    try {
      if (lead && typeof lead.markPixCreated === 'function') {
        lead.markPixCreated(wa_id, {
          provider,
          external_id,
          transaction_id,
          status,
          offer_id: offer_id || null,
          amount,
          created_ts_ms: row?.created_at?.getTime?.() || Date.now(),
        });
      }
    } catch { /* noop */ }

    try {
      const st = lead?.getLead?.(wa_id);
      logger.log('[LEAD][STATE][PIX_BEFORE_META]', lead?.__store_id, {
        wa_id,
        has_meta: !!st?.meta_ads,
        has_last: !!st?.last_ads_lookup,
        has_inflight: !!st?.meta_ads_inflight,
      });
    } catch { }

    const tWait0 = Date.now();
    const meta_ads = await getMetaAdsForWa(wa_id, { waitMs: 3500 });
    const waitedMs = Date.now() - tWait0;

    if (!meta_ads) {
      logger.log('[UTMIFY][META_ADS][MISSING][PENDING]', { wa_id, external_id });
    } else {
      logger.log('[UTMIFY][META_ADS][ATTACH][PENDING]', {
        wa_id,
        external_id,
        waitedMs,
        campaign: meta_ads?.campaign_name || meta_ads?.ids?.campaign_id || null,
        ad: meta_ads?.ad_name || meta_ads?.ids?.ad_id || null,
        sck: meta_ads?.referral?.ctwa_clid ? short(meta_ads.referral.ctwa_clid, 12) : null,
      });
    }

    try {
      await utmify.send('waiting_payment', {
        external_id,
        amount,
        payer_name: payer?.name || 'Cliente',
        payer_email: payer?.email || 'cliente@teste.com',
        payer_phone: payer?.phone || null,
        payer_document: payer?.document || null,
        offer_id: offer_id || null,
        offer_title: offer_title || meta?.offer_title || 'Pagamento',
        createdAt: row?.created_at?.getTime?.() || Date.now(),

        // ✅ anexado para virar trackingParameters no utmify.js
        meta_ads,
      });
    } catch (e) {
      logger.warn('[UTMIFY][WARN] waiting_payment', { message: e?.message });
    }

    return {
      ok: true,
      provider,
      external_id,
      transaction_id,
      status,
      qrcode,
      row,
    };
  }

  async function handleWebhook(provider, payload) {
    const p = normalizeProvider(provider) || 'veltrax';
    const gw = providers[p];
    if (!gw) return;

    const norm = gw.normalizeWebhook(payload);
    const status = String(norm?.status || '').trim();

    logger.log(`[${upper(p)}][WEBHOOK]`, {
      status,
      transaction_id: norm?.transaction_id,
      external_id: norm?.external_id,
      total: norm?.total,
    });

    let row = null;
    try {
      if (!norm?.external_id && norm?.transaction_id) {
        row = await db.getPixDepositByTransactionId(p, norm.transaction_id);
        if (row?.external_id) norm.external_id = row.external_id;
      }

      row = await db.updatePixDepositFromWebhookNormalized({
        provider: p,
        transaction_id: norm?.transaction_id || null,
        external_id: norm?.external_id || null,
        status: norm?.status || null,
        fee: norm?.fee ?? null,
        net_amount: norm?.net_amount ?? null,
        end_to_end: norm?.end_to_end || null,
        raw_webhook: payload,
      });
    } catch (e) {
      logger.warn(`[${upper(p)}][WEBHOOK][DB_WARN]`, { message: e?.message });
    }

    const paid = gw.isPaidStatus(status);

    let wa_id = row?.wa_id || null;
    if (!wa_id) wa_id = parseWaIdFromExternalId(norm?.external_id);

    if (!paid) return;

    if (!wa_id) {
      logger.warn(`[${upper(p)}][WEBHOOK][PAID_NO_WA]`, {
        transaction_id: norm?.transaction_id,
        external_id: norm?.external_id,
      });
      return;
    }

    publishState?.({
      wa_id,
      etapa: `${upper(p)}_PAID`,
      vars: {
        provider: p,
        offer_id: row?.offer_id || null,
        amount: Number(row?.amount || (norm?.total || 0) / 100),
        total_cents: norm?.total ?? null,
        external_id: norm?.external_id ?? null,
        transaction_id: norm?.transaction_id ?? null,
        end_to_end: norm?.end_to_end ?? null,
        status,
      },
      ts: Date.now(),
    });

    try {
      if (lead && typeof lead.markPaymentCompleted === 'function') {
        lead.markPaymentCompleted(wa_id, {
          provider: p,
          offer_id: row?.offer_id || null,
          amount: Number(row?.amount || (norm?.total || 0) / 100),
          amount_cents: norm?.total ?? null,
          external_id: norm?.external_id ?? null,
          transaction_id: norm?.transaction_id ?? null,
          end_to_end: norm?.end_to_end ?? null,
          status,
        });
      }
    } catch { /* noop */ }

    const payer_name = row?.payer_name || payload?.customer?.name || payload?.payer?.name || 'Cliente';
    const payer_email = row?.payer_email || payload?.customer?.email || payload?.payer?.email || 'cliente@teste.com';
    const payer_phone = row?.payer_phone || payload?.customer?.phone || payload?.payer?.phone || null;
    const payer_document = row?.payer_document || payload?.customer?.document || payload?.payer?.document || null;

    // ✅ UTMify: paid + meta_ads do lead
    let meta_ads = await getMetaAdsForWa(wa_id, { waitMs: 800 });

    // fallback: tenta reaproveitar algo salvo no row (caso exista no seu schema)
    if (!meta_ads) {
      try {
        meta_ads =
          row?.meta_ads ||
          row?.ads_lookup ||
          row?.raw_create_response?.meta_ads ||
          null;

        // se você salva como string JSON em algum lugar
        if (!meta_ads && typeof row?.meta_ads_json === 'string') {
          meta_ads = JSON.parse(row.meta_ads_json);
        }
      } catch { /* noop */ }
    }

    if (meta_ads) {
      logger.log('[UTMIFY][META_ADS][ATTACH][PAID]', {
        wa_id,
        external_id: norm?.external_id || row?.external_id || null,
        campaign: meta_ads?.campaign_name || meta_ads?.ids?.campaign_id || null,
        ad: meta_ads?.ad_name || meta_ads?.ids?.ad_id || null,
        sck: meta_ads?.referral?.ctwa_clid ? short(meta_ads.referral.ctwa_clid, 12) : null,
      });
    } else {
      logger.log('[UTMIFY][META_ADS][MISSING][PAID]', {
        wa_id,
        external_id: norm?.external_id || row?.external_id || null,
      });
    }

    try {
      await utmify.send('paid', {
        external_id: norm?.external_id || row?.external_id,
        amount: Number(row?.amount || (norm?.total || 0) / 100),
        payer_name,
        payer_email,
        payer_phone,
        payer_document,
        offer_id: row?.offer_id || null,
        offer_title: 'Pagamento',
        createdAt: row?.created_at?.getTime?.() || Date.now(),

        // ✅ anexado para virar trackingParameters no utmify.js
        meta_ads,
      });
    } catch (e) {
      logger.warn('[UTMIFY][WARN] paid', { message: e?.message });
    }
  }

  function makeExpressWebhookHandler(provider) {
    return async (req, res) => {
      res.sendStatus(200);
      try {
        await handleWebhook(provider, req.body || {});
      } catch (e) {
        logger.warn(`[${upper(provider)}][WEBHOOK][ERR]`, { message: e?.message });
      }
    };
  }

  return {
    createPixCharge,
    handleWebhook,
    makeExpressWebhookHandler,
    providers,
  };
}

module.exports = { createPaymentsModule };

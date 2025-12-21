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

function safeJson(x) {
  try { return x ? JSON.stringify(x) : null; } catch { return null; }
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

  // ✅ UTMify client (DI) - agora vem do ./utmify (arquivo único)
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

  async function createPixCharge({
    ctx,                 // opcional (pra pegar hints)
    wa_id,
    offer_id,
    offer_title,
    amount,
    extKey,
    payer,               // {name,email,document,phone,documentType?}
    providerHint,        // opcional
    meta,                // opcional
  }) {
    const settings = await db.getBotSettings();

    const provider =
      normalizeProvider(providerHint) ||
      pickProviderFromCtx(ctx, { offer: meta?.offer }) ||
      getDefaultProviderFromSettings(settings);

    const gw = providers[provider];
    if (!gw) throw new Error(`[payments] provider not found: ${provider}`);

    const callbackUrl = buildCallbackUrl(provider, settings);

    // só exige callback se provider disser que precisa
    if (gw.requiresCallback && !callbackUrl) {
      return { ok: false, reason: 'missing-callback-url', provider };
    }

    // tenta 2x pra lidar com colisão external_id (409 etc.)
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

    // Persistência (pix_deposits)
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

    // UTMify: pending (waiting_payment)
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

    // 1) resolve external_id se vier só transaction_id
    let row = null;
    try {
      if (!norm?.external_id && norm?.transaction_id) {
        row = await db.getPixDepositByTransactionId(p, norm.transaction_id);
        if (row?.external_id) norm.external_id = row.external_id;
      }

      // 2) atualiza
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

    // resolve wa_id
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

    // eventos internos
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

    // marca no lead (se existir)
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

    // UTMify: paid (fallback payer se row não tiver)
    const payer_name = row?.payer_name || payload?.customer?.name || payload?.payer?.name || 'Cliente';
    const payer_email = row?.payer_email || payload?.customer?.email || payload?.payer?.email || 'cliente@teste.com';
    const payer_phone = row?.payer_phone || payload?.customer?.phone || payload?.payer?.phone || null;
    const payer_document = row?.payer_document || payload?.customer?.document || payload?.payer?.document || null;

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
    providers, // útil p/ debug
  };
}

module.exports = { createPaymentsModule };

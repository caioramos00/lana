// payments/pix.js
'use strict';

const axios = require('axios');
const createProviders = require('./providers');

// ✅ config/ofertas ficam em actions/config.js (como no seu ai.js)
const {
  CONFIG,
  getPixForCtx,
  moneyBRL,
  getOfferById,
} = require('../actions/config');

const PROVIDERS = createProviders({ axios, logger: console });

function normalizeProvider(p) {
  const id = String(p || '').trim().toLowerCase();
  return PROVIDERS[id] ? id : null;
}

function pickProviderFromCtx(ctx, { offer } = {}) {
  const fromCtx =
    ctx?.vars?.pix_gateway ||
    ctx?.vars?.gateway ||
    ctx?.agent?.pix_gateway ||
    ctx?.agent?.gateway ||
    (offer && offer.gateway) ||
    global?.botSettings?.pix_gateway_default ||
    'veltrax';

  return normalizeProvider(fromCtx) || 'veltrax';
}

// Mantém o comportamento anterior: só gera callbackUrl para gateways que precisam
function buildCallbackUrl(provider) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = PROVIDERS[p];

  // se o provider não exige callback no createPix, retorna null e pronto
  if (!gw?.requiresCallback) return null;

  if (p === 'veltrax') {
    const base = String(
      global.veltraxConfig?.callback_base_url ||
      global.botSettings?.veltrax_callback_base_url ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    const path = String(
      global.veltraxConfig?.webhook_path ||
      global.botSettings?.veltrax_webhook_path ||
      '/webhook/veltrax'
    ).trim() || '/webhook/veltrax';
    if (!base) return null;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  if (p === 'rapdyn') {
    const base = String(
      global.rapdynConfig?.callback_base_url ||
      global.botSettings?.rapdyn_callback_base_url ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    const path = String(
      global.rapdynConfig?.webhook_path ||
      global.botSettings?.rapdyn_webhook_path ||
      '/webhook/rapdyn'
    ).trim() || '/webhook/rapdyn';
    if (!base) return null;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  // fallback (se você colocar outros providers que exijam callback no futuro)
  const base = String(global.botSettings?.[`${p}_callback_base_url`] || '')
    .trim()
    .replace(/\/+$/, '');
  const path = String(global.botSettings?.[`${p}_webhook_path`] || `/webhook/${p}`)
    .trim() || `/webhook/${p}`;
  if (!base) return null;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function createPix(provider, { amount, external_id, callbackUrl, payer, meta }) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = PROVIDERS[p];

  // settings vai para o provider novo (zoompag), e é ignorado pelos wrappers legacy
  const settings =
    global?.botSettings ||
    global?.settings ||
    {};

  return gw.createPix({ amount, external_id, callbackUrl, payer, meta, settings });
}

function normalizeWebhook(provider, payload) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = PROVIDERS[p];
  return gw.normalizeWebhook(payload);
}

function isPaidStatus(provider, status) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = PROVIDERS[p];
  return gw.isPaidStatus(status);
}

/* ===========================
   ✅ ACTION: enviar_pix (ficou aqui)
   - substitui actions/handlers/enviar_pix.js
   =========================== */

function pickOfferId(ctx) {
  return String(
    ctx?.agent?.offer_id ||
    ctx?.agent?.offerId ||
    ctx?.vars?.offer_id ||
    ctx?.vars?.offerId ||
    ''
  ).trim() || null;
}

function normalizePhone(v) {
  const s = String(v || '').replace(/\D/g, '');
  return s || null;
}

/**
 * Handler da action enviar_pix.
 * Assinatura compatível com o runner: handler(ctx, payload)
 */
async function enviar_pix(ctx, _payload) {
  const wa_id = String(ctx?.wa_id || ctx?.waId || '').trim();
  const fase = String(ctx?.agent?.proxima_fase || '').trim();
  const offer_id = pickOfferId(ctx);

  const offer = offer_id ? (getOfferById(offer_id) || null) : null;

  const amount =
    offer && Number.isFinite(Number(offer.preco))
      ? Number(offer.preco)
      : Number(getPixForCtx(ctx).valor);

  const amountFmt = (typeof moneyBRL === 'function')
    ? moneyBRL(amount)
    : `R$ ${Number(amount || 0).toFixed(2).replace('.', ',')}`;

  // payer (modo teste)
  const payer = {
    name: 'Cliente',
    email: 'cliente@teste.com',
    document: '50728383829',
    phone: normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id),
  };

  if (!ctx?.payments?.createPixCharge) {
    await ctx.sendText('Config de pagamento incompleta (payments module).', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return { ok: false, reason: 'missing-payments-module' };
  }

  const extKey = offer_id || (fase || 'fase');

  const created = await ctx.payments.createPixCharge({
    ctx,
    wa_id,
    offer_id,
    offer_title: offer?.titulo || 'Pagamento',
    amount,
    extKey,
    payer,
    meta: {
      fase,
      offer, // ajuda a escolher gateway se você tiver offer.gateway
      product_name: offer?.titulo || null,
      offer_title: offer?.titulo || null,
    },
  });

  if (!created?.ok) {
    if (created?.reason === 'missing-callback-url') {
      await ctx.sendText('Config de pagamento incompleta (callback URL).', {
        reply_to_wamid: ctx.replyToWamid,
      });
      return created;
    }

    await ctx.sendText('Deu erro ao gerar o Pix. Tenta de novo.', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return created;
  }

  const { provider, external_id, transaction_id, status, qrcode } = created;

  // salva no agent
  if (ctx?.agent) {
    ctx.agent.pix_provider = provider;
    ctx.agent.pix_external_id = external_id;
    ctx.agent.pix_transaction_id = transaction_id;
    ctx.agent.pix_status = status;
    ctx.agent.offer_id = offer_id || ctx.agent.offer_id || null;
  }

  await ctx.sendText('Fechou. vou te mandar o pix agora.', { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();

  await ctx.sendText(`Valor: ${amountFmt}`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();

  if (offer?.titulo) {
    await ctx.sendText(`Do: ${offer.titulo}`, { reply_to_wamid: ctx.replyToWamid });
    await ctx.delay();
  }

  await ctx.sendText('Copia e cola:', { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();

  if (qrcode) {
    await ctx.sendText(String(qrcode), { reply_to_wamid: ctx.replyToWamid });
  } else {
    await ctx.sendText('Não veio o código Pix. Vou precisar gerar de novo.', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return {
      ok: false,
      reason: 'missing-qrcode',
      provider,
      external_id,
      transaction_id,
      status,
    };
  }

  if (CONFIG?.pix?.mensagemExtra) {
    await ctx.delay();
    await ctx.sendText(CONFIG.pix.mensagemExtra, { reply_to_wamid: ctx.replyToWamid });
  }

  return {
    ok: true,
    provider,
    external_id,
    transaction_id,
    status,
    offer_id: offer_id || null,
    amount,
  };
}

module.exports = {
  GATEWAYS: PROVIDERS,
  normalizeProvider,
  pickProviderFromCtx,
  buildCallbackUrl,
  createPix,
  normalizeWebhook,
  isPaidStatus,
  enviar_pix,
};

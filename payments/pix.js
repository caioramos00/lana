'use strict';

const axios = require('axios');
const createProviders = require('./providers');

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

module.exports = {
  // mantém o nome antigo pra não quebrar nada
  GATEWAYS: PROVIDERS,
  normalizeProvider,
  pickProviderFromCtx,
  buildCallbackUrl,
  createPix,
  normalizeWebhook,
  isPaidStatus,
};

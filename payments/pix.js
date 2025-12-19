// payments/pix.js
const veltraxGw = require('./providers/veltrax-gateway');
const rapdynGw = require('./providers/rapdyn-gateway');

const GATEWAYS = {
  veltrax: veltraxGw,
  rapdyn: rapdynGw,
};

function normalizeProvider(p) {
  const id = String(p || '').trim().toLowerCase();
  return GATEWAYS[id] ? id : null;
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

function buildCallbackUrl(provider) {
  const p = normalizeProvider(provider) || 'veltrax';

  if (p === 'veltrax') {
    const base = String(global.veltraxConfig?.callback_base_url || global.botSettings?.veltrax_callback_base_url || '')
      .trim()
      .replace(/\/+$/, '');
    const path = String(global.veltraxConfig?.webhook_path || global.botSettings?.veltrax_webhook_path || '/webhook/veltrax')
      .trim() || '/webhook/veltrax';
    if (!base) return null;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  if (p === 'rapdyn') {
    const base = String(global.rapdynConfig?.callback_base_url || global.botSettings?.rapdyn_callback_base_url || '')
      .trim()
      .replace(/\/+$/, '');
    const path = String(global.rapdynConfig?.webhook_path || global.botSettings?.rapdyn_webhook_path || '/webhook/rapdyn')
      .trim() || '/webhook/rapdyn';
    if (!base) return null;
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  return null;
}

async function createPix(provider, { amount, external_id, callbackUrl, payer, meta }) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = GATEWAYS[p];
  return gw.createPix({ amount, external_id, callbackUrl, payer, meta });
}

function normalizeWebhook(provider, payload) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = GATEWAYS[p];
  return gw.normalizeWebhook(payload);
}

function isPaidStatus(provider, status) {
  const p = normalizeProvider(provider) || 'veltrax';
  const gw = GATEWAYS[p];
  return gw.isPaidStatus(status);
}

module.exports = {
  GATEWAYS,
  normalizeProvider,
  pickProviderFromCtx,
  buildCallbackUrl,
  createPix,
  normalizeWebhook,
  isPaidStatus,
};

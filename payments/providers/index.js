// payments/providers/index.js
'use strict';

const createZoompag = require('./zoompag');

// TODO: refatore veltrax/rapdyn pro mesmo padrão e adicione aqui:
const veltraxGw = require('../providers/veltrax-gateway'); // (compat: seu antigo)
const rapdynGw = require('../providers/rapdyn-gateway');   // (compat: seu antigo)

// wrapper de compat p/ seus gateways antigos (enquanto você migra)
function wrapLegacy(gw, id, requiresCallback = true) {
  return {
    id,
    requiresCallback,
    createPix: async ({ amount, external_id, callbackUrl, payer, meta }) =>
      gw.createPix({ amount, external_id, callbackUrl, payer, meta }),
    normalizeWebhook: (payload) => gw.normalizeWebhook(payload),
    isPaidStatus: (status) => gw.isPaidStatus(status),
  };
}

module.exports = function createProviders({ axios, logger } = {}) {
  return {
    zoompag: createZoompag({ axios, logger }),

    // compat: mantenha até migrar veltrax/rapdyn pro padrão novo (sem global)
    veltrax: wrapLegacy(veltraxGw, 'veltrax', true),
    rapdyn: wrapLegacy(rapdynGw, 'rapdyn', true),
  };
};

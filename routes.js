'use strict';

const { registerAdminRoutes } = require('./routes/admin');
const { registerMetaRoutes } = require('./routes/meta');
const { registerMediaRoutes } = require('./routes/media');
const { registerPaymentRoutes, assertPaymentsInjected } = require('./routes/payment');

function registerRoutes(app, deps = {}) {
  assertPaymentsInjected(deps.payments);

  registerAdminRoutes(app, deps);
  registerMetaRoutes(app, deps);
  registerMediaRoutes(app, deps);
  registerPaymentRoutes(app, deps);
}

module.exports = { registerRoutes };

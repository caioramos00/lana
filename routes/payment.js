'use strict';

function assertPaymentsInjected(payments) {
  if (!payments || typeof payments.makeExpressWebhookHandler !== 'function') {
    console.error('[ROUTES][BOOT][FATAL] payments não foi injetado em registerRoutes().');
    throw new Error('payments singleton não foi fornecido para registerRoutes (evite duplicar instâncias).');
  }
}

function getVeltraxWebhookPaths() {
  const p = String(global.veltraxConfig?.webhook_path || '/webhook/veltrax').trim() || '/webhook/veltrax';
  return [...new Set(['/webhook/veltrax', p])];
}

function getRapdynWebhookPaths() {
  const p = String(global.rapdynConfig?.webhook_path || global.botSettings?.rapdyn_webhook_path || '/webhook/rapdyn').trim() || '/webhook/rapdyn';
  return [...new Set(['/webhook/rapdyn', p])];
}

function getZoompagWebhookPaths() {
  const p = String(global.zoompagConfig?.webhook_path || global.botSettings?.zoompag_webhook_path || '/webhook/zoompag').trim() || '/webhook/zoompag';
  return [...new Set(['/webhook/zoompag', p])];
}

function getSafepixWebhookPaths() {
  const p = String(global.safepixConfig?.webhook_path || global.botSettings?.safepix_webhook_path || '/webhook/safepix').trim() || '/webhook/safepix';
  return [...new Set(['/webhook/safepix', p])];
}

function registerPaymentRoutes(app, { payments } = {}) {
  assertPaymentsInjected(payments);

  for (const webhookPath of getVeltraxWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('veltrax'));
  }
  for (const webhookPath of getRapdynWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('rapdyn'));
  }
  for (const webhookPath of getZoompagWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('zoompag'));
  }
  for (const webhookPath of getSafepixWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('safepix'));
  }
}

module.exports = { registerPaymentRoutes, assertPaymentsInjected };

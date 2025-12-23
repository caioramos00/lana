// db.js
const { Pool } = require('pg');

function envInt(name, def) {
  const v = process.env[name];
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envStr(name, def) {
  const v = process.env[name];
  if (v === undefined || v === null) return def;
  const s = String(v);
  return s.length ? s : def;
}

function envSsl() {
  if (process.env.PG_SSL === 'false') return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: envSsl(),
  keepAlive: true,
  max: envInt('PGPOOL_MAX', 10),
  idleTimeoutMillis: envInt('PG_IDLE_TIMEOUT', 30000),
  connectionTimeoutMillis: envInt('PG_CONN_TIMEOUT', 5000),
});

pool.on('error', (err) => {
  console.error('[PG][POOL][ERROR]', { code: err?.code, message: err?.message });
});

function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toFloatOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return null;
}

function clampInt(n, { min, max } = {}) {
  if (!Number.isFinite(n)) return null;
  let x = Math.trunc(n);
  if (Number.isFinite(min)) x = Math.max(min, x);
  if (Number.isFinite(max)) x = Math.min(max, x);
  return x;
}

function clampFloat(n, { min, max } = {}) {
  if (!Number.isFinite(n)) return null;
  let x = n;
  if (Number.isFinite(min)) x = Math.max(min, x);
  if (Number.isFinite(max)) x = Math.min(max, x);
  return x;
}

function normalizeKindDb(k) {
  const v = String(k || '').trim().toLowerCase();
  if (v === 'fotos') return 'foto';
  if (v === 'videos') return 'video';
  return v;
}

function isValidKindDb(k) {
  const v = normalizeKindDb(k);
  return v === 'foto' || v === 'video';
}

function toBoolLoose(v, def = null) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return def;
}

function slugifyBase(s) {
  const out = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return out || 'offer';
}

function normalizeOfferIdInput(v) {
  const s = String(v ?? '').trim();
  return s ? s.toLowerCase() : null;
}

function isValidOfferIdFormat(s) {
  return /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(String(s || ''));
}

function ensureValidOfferId(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) throw new Error('offer_id é obrigatório');
  if (!isValidOfferIdFormat(v)) {
    throw new Error('offer_id inválido. Use apenas letras/números/_/-, até 80 chars (ex: pack-10-fotos).');
  }
  return v;
}

function normalizeKindPreview(k) {
  const v = String(k || '').trim().toLowerCase();
  if (v === 'fotos') return 'foto';
  if (v === 'videos') return 'video';
  return v;
}

function isValidKindPreview(k) {
  const v = normalizeKindPreview(k);
  return v === 'foto' || v === 'video';
}

function ensureValidPreviewId(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) throw new Error('preview_id é obrigatório');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(v)) {
    throw new Error('preview_id inválido. Use letras/números/_/-, até 80 chars (ex: previa-pack-1).');
  }
  return v;
}

function slugifyPreviewBase(s) {
  const out = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return out || 'previa';
}

const helpers = {
  strOrNull,
  toIntOrNull,
  toFloatOrNull,
  toBoolOrNull,
  clampInt,
  clampFloat,
  normalizeKindDb,
  isValidKindDb,
  toBoolLoose,
  slugifyBase,
  normalizeOfferIdInput,
  isValidOfferIdFormat,
  ensureValidOfferId,
  normalizeKindPreview,
  isValidKindPreview,
  ensureValidPreviewId,
  slugifyPreviewBase,
};

const settingsCache = {
  value: null,
  ts: 0,
  ttlMs: envInt('BOT_SETTINGS_TTL_MS', 60_000),
};

const { createInit } = require('./db/init');
const { createSettings } = require('./db/settings');
const { createStore } = require('./db/store');

const initApi = createInit({ pool });
const settingsApi = createSettings({ pool, helpers, cache: settingsCache });
const storeApi = createStore({ pool, helpers });

module.exports = {
  pool,
  initDatabase: initApi.initDatabase,
  getBotSettings: settingsApi.getBotSettings,
  updateBotSettings: settingsApi.updateBotSettings,
  listMetaNumbers: storeApi.listMetaNumbers,
  getMetaNumberByPhoneNumberId: storeApi.getMetaNumberByPhoneNumberId,
  getDefaultMetaNumber: storeApi.getDefaultMetaNumber,
  createMetaNumber: storeApi.createMetaNumber,
  updateMetaNumber: storeApi.updateMetaNumber,
  deleteMetaNumber: storeApi.deleteMetaNumber,
  createVeltraxDepositRow: storeApi.createVeltraxDepositRow,
  updateVeltraxDepositFromWebhook: storeApi.updateVeltraxDepositFromWebhook,
  countVeltraxAttempts: storeApi.countVeltraxAttempts,
  getLatestPendingVeltraxDeposit: storeApi.getLatestPendingVeltraxDeposit,
  createPixDepositRow: storeApi.createPixDepositRow,
  updatePixDepositFromWebhookNormalized: storeApi.updatePixDepositFromWebhookNormalized,
  getPixDepositByTransactionId: storeApi.getPixDepositByTransactionId,
  countPixAttempts: storeApi.countPixAttempts,
  getLatestPendingPixDeposit: storeApi.getLatestPendingPixDeposit,
  getFulfillmentOfferWithMedia: storeApi.getFulfillmentOfferWithMedia,
  listFulfillmentOffers: storeApi.listFulfillmentOffers,
  tryStartFulfillmentDelivery: storeApi.tryStartFulfillmentDelivery,
  markFulfillmentDeliverySent: storeApi.markFulfillmentDeliverySent,
  markFulfillmentDeliveryFailed: storeApi.markFulfillmentDeliveryFailed,
  createFulfillmentOffer: storeApi.createFulfillmentOffer,
  updateFulfillmentOffer: storeApi.updateFulfillmentOffer,
  deleteFulfillmentOffer: storeApi.deleteFulfillmentOffer,
  createFulfillmentMedia: storeApi.createFulfillmentMedia,
  updateFulfillmentMedia: storeApi.updateFulfillmentMedia,
  deleteFulfillmentMedia: storeApi.deleteFulfillmentMedia,
  listPreviewOffers: storeApi.listPreviewOffers,
  getPreviewOfferWithMedia: storeApi.getPreviewOfferWithMedia,
  createPreviewOffer: storeApi.createPreviewOffer,
  updatePreviewOffer: storeApi.updatePreviewOffer,
  deletePreviewOffer: storeApi.deletePreviewOffer,
  createPreviewMedia: storeApi.createPreviewMedia,
  updatePreviewMedia: storeApi.updatePreviewMedia,
  deletePreviewMedia: storeApi.deletePreviewMedia,
};

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db.js');
const { rememberInboundMetaPhoneNumberId, sendMessage } = require('./senders');
const { sseRouter } = require('./stream/sse-router');
const { publishMessage, publishAck, publishState } = require('./stream/events-bus');

const { createLeadStore } = require('./lead');
const { createAiEngine } = require('./ai');
const { registerRoutes } = require('./routes');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
}));

app.use(sseRouter);

async function bootstrapDb() {
  let attempt = 0;
  while (attempt < 8) {
    try {
      await db.initDatabase();
      const settings = await db.getBotSettings({ bypassCache: true });

      global.botSettings = settings;

      global.veniceConfig = {
        venice_api_key: settings.venice_api_key,
        venice_model: settings.venice_model,
        system_prompt: settings.system_prompt,
      };

      global.veltraxConfig = {
        api_base_url: String(settings.veltrax_api_base_url || 'https://api.veltraxpay.com').trim(),
        client_id: String(settings.veltrax_client_id || '').trim(),
        client_secret: String(settings.veltrax_client_secret || '').trim(),
        callback_base_url: String(settings.veltrax_callback_base_url || '').trim(),
        webhook_path: String(settings.veltrax_webhook_path || '/webhook/veltrax').trim(),
      };

      return;
    } catch (e) {
      attempt++;
      await new Promise(r => setTimeout(r, 1500 * attempt));
      console.error('[DB][BOOTSTRAP][RETRY]', { attempt, code: e?.code, message: e?.message });
    }
  }

  console.error('[DB][BOOTSTRAP][ERROR] failed after retries');
  throw new Error('Falha ao iniciar DB');
}

function isAiDebugOn() {
  const v = global.botSettings?.ai_debug;
  if (v === undefined || v === null) return true;
  return !!v;
}

function aiLog(...args) {
  if (!isAiDebugOn()) return;
  console.log(...args);
}

function readBatchingFromSettings(settings) {
  const s = settings || {};
  const dMin = Number(s.inbound_debounce_min_ms);
  const dMax = Number(s.inbound_debounce_max_ms);
  const maxW = Number(s.inbound_max_wait_ms);

  let inboundDebounceMinMs = Number.isFinite(dMin) ? dMin : 1800;
  let inboundDebounceMaxMs = Number.isFinite(dMax) ? dMax : 3200;
  let inboundMaxWaitMs = Number.isFinite(maxW) ? maxW : 12000;

  if (inboundDebounceMinMs > inboundDebounceMaxMs) {
    const tmp = inboundDebounceMinMs;
    inboundDebounceMinMs = inboundDebounceMaxMs;
    inboundDebounceMaxMs = tmp;
  }

  return { inboundDebounceMinMs, inboundDebounceMaxMs, inboundMaxWaitMs };
}

function readLeadFromSettings(settings) {
  const s = settings || {};
  const maxMsgs = Number(s.lead_max_msgs);
  const ttlMs = Number(s.lead_ttl_ms);
  const lateJoinWindowMs = Number(s.lead_late_join_window_ms);
  const previewTextMaxLen = Number(s.lead_preview_text_max_len);

  return {
    maxMsgs: Number.isFinite(maxMsgs) ? maxMsgs : 50,
    ttlMs: Number.isFinite(ttlMs) ? ttlMs : (7 * 24 * 60 * 60 * 1000),
    lateJoinWindowMs: Number.isFinite(lateJoinWindowMs) ? lateJoinWindowMs : 350,
    previewTextMaxLen: Number.isFinite(previewTextMaxLen) ? previewTextMaxLen : 80,
    debugDebounce: (s.lead_debug_debounce === undefined || s.lead_debug_debounce === null)
      ? true
      : !!s.lead_debug_debounce,
  };
}

(async () => {
  await bootstrapDb();

  const ai = createAiEngine({
    db,
    sendMessage,
    aiLog,
  });

  const batching = readBatchingFromSettings(global.botSettings);
  const leadCfg = readLeadFromSettings(global.botSettings);

  const lead = createLeadStore({
    maxMsgs: leadCfg.maxMsgs,
    ttlMs: leadCfg.ttlMs,

    inboundDebounceMinMs: batching.inboundDebounceMinMs,
    inboundDebounceMaxMs: batching.inboundDebounceMaxMs,
    inboundMaxWaitMs: batching.inboundMaxWaitMs,

    lateJoinWindowMs: leadCfg.lateJoinWindowMs,
    previewTextMaxLen: leadCfg.previewTextMaxLen,

    debugDebounce: leadCfg.debugDebounce,
    debugLog: aiLog,

    onFlushBlock: async (payload) => {
      return ai.handleInboundBlock({ ...payload, lead });
    },
  });

  registerRoutes(app, {
    db,
    lead,
    rememberInboundMetaPhoneNumberId,
    publishMessage,
    publishAck,
    publishState,
  });

  const PORT = 3000;
  app.listen(PORT, () => { });
})();
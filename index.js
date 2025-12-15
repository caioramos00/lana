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
  secret: process.env.SESSION_SECRET || 'dev-secret',
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

      return;
    } catch (e) {
      attempt++;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error('Falha ao iniciar DB');
}

const AI_DEBUG = true;
function aiLog(...args) {
  if (!AI_DEBUG) return;
  console.log(...args);
}

function readBatchingFromSettings(settings) {
  const s = settings || {};
  const dMin = Number(s.inbound_debounce_min_ms);
  const dMax = Number(s.inbound_debounce_max_ms);
  const maxW = Number(s.inbound_max_wait_ms);

  let inboundDebounceMinMs = Number.isFinite(dMin) ? dMin : 1800;
  let inboundDebounceMaxMs = Number.isFinite(dMax) ? dMax : 3200;
  let inboundMaxWaitMs     = Number.isFinite(maxW) ? maxW : 12000;

  if (inboundDebounceMinMs > inboundDebounceMaxMs) {
    const tmp = inboundDebounceMinMs;
    inboundDebounceMinMs = inboundDebounceMaxMs;
    inboundDebounceMaxMs = tmp;
  }

  return { inboundDebounceMinMs, inboundDebounceMaxMs, inboundMaxWaitMs };
}

(async () => {
  await bootstrapDb();

  const ai = createAiEngine({
    db,
    sendMessage,
    aiLog,
  });

  let lead;

  // ✅ pega do DB (settings)
  const batching = readBatchingFromSettings(global.botSettings);

  lead = createLeadStore({
    maxMsgs: 50,
    ttlMs: 7 * 24 * 60 * 60 * 1000,

    inboundDebounceMinMs: batching.inboundDebounceMinMs,
    inboundDebounceMaxMs: batching.inboundDebounceMaxMs,
    inboundMaxWaitMs: batching.inboundMaxWaitMs,

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

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => { });
})();

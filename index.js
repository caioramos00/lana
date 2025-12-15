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

// ===== Views / Admin =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ✅ session middleware (tava faltando)
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
}));

// ===== SSE =====
app.use(sseRouter);

// ===== Bootstrap DB + Settings em memória =====
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

// ===== AI DEBUG =====
const AI_DEBUG = true;
function aiLog(...args) {
  if (!AI_DEBUG) return;
  console.log(...args);
}

(async () => {
  await bootstrapDb();

  // AI engine (Venice + parse + envio)
  const ai = createAiEngine({
    db,
    sendMessage,
    aiLog,
  });

  // ✅ a gente declara lead antes pra poder fechar no onFlushBlock
  let lead;

  // Lead store (memória + batching) — chama ai quando “flush” acontecer
  lead = createLeadStore({
    maxMsgs: 50,
    ttlMs: 7 * 24 * 60 * 60 * 1000,

    inboundDebounceMinMs: Number(process.env.INBOUND_DEBOUNCE_MIN_MS || 800),
    inboundDebounceMaxMs: Number(process.env.INBOUND_DEBOUNCE_MAX_MS || 1500),
    inboundMaxWaitMs: Number(process.env.INBOUND_MAX_WAIT_MS || 7000),

    // ✅ AGORA chama a função REAL e injeta lead
    onFlushBlock: async (payload) => {
      return ai.handleInboundBlock({ ...payload, lead });
    },
  });

  // Rotas (admin + webhook)
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

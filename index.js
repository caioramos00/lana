// index.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');

const db = require('./db.js');
const { rememberInboundMetaPhoneNumberId, sendMessage } = require('./senders');
const { sseRouter } = require('./stream/sse-router');
const { publishMessage, publishAck, publishState } = require('./stream/events-bus');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ===== Views / Admin =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
}));

function checkAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
}

// ===== SSE =====
app.use(sseRouter);

// ===== Memória (até 50 msgs por lead, expira em 7 dias) =====
const leadStore = new Map();
const MAX_MSGS = 50;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function now() { return Date.now(); }

function getLead(wa_id) {
  const key = String(wa_id || '').trim();
  if (!key) return null;

  let st = leadStore.get(key);
  if (!st) {
    st = {
      wa_id: key,
      history: [],
      expiresAt: now() + TTL_MS,
      meta_phone_number_id: null,
      last_user_ts: null,
      created_at: now(),
    };
    leadStore.set(key, st);
  }
  st.expiresAt = now() + TTL_MS;
  return st;
}

function pushHistory(wa_id, role, text, extra = {}) {
  const st = getLead(wa_id);
  if (!st) return;

  st.history.push({
    role,
    text: String(text || ''),
    ts: new Date().toISOString(),
    ...extra,
  });

  if (role === 'user') st.last_user_ts = now();

  if (st.history.length > MAX_MSGS) {
    st.history.splice(0, st.history.length - MAX_MSGS);
  }
}

setInterval(() => {
  const t = now();
  for (const [k, v] of leadStore.entries()) {
    if (!v?.expiresAt || v.expiresAt <= t) leadStore.delete(k);
  }
}, 60 * 60 * 1000);

// ===== Helpers =====
function buildHistoryString(st) {
  const hist = Array.isArray(st?.history) ? st.history : [];
  return hist
    .slice(-MAX_MSGS)
    .map((m) => {
      const who = m.role === 'assistant' ? 'ASSISTANT' : (m.role === 'user' ? 'USER' : 'SYSTEM');
      const t = String(m.text || '').replace(/\s+/g, ' ').trim();
      return `${who}: ${t}`;
    })
    .join('\n');
}

function buildFactsJson(st, inboundPhoneNumberId) {
  const lastTs = st?.last_user_ts ? st.last_user_ts : null;
  const hoursSince = lastTs ? Math.max(0, (now() - lastTs) / 3600000) : 0;

  const totalUserMsgs = (st?.history || []).filter(x => x.role === 'user').length;
  const status_lead = totalUserMsgs <= 1 ? 'NOVO' : 'EM_CONVERSA';

  return {
    status_lead,
    horas_desde_ultima_mensagem_usuario: Math.round(hoursSince * 100) / 100,
    motivo_interacao: 'RESPOSTA_USUARIO',
    ja_comprou_vip: false,
    lead_pediu_pra_parar: false,
    meta_phone_number_id: inboundPhoneNumberId || st?.meta_phone_number_id || null,
  };
}

function renderSystemPrompt(template, factsObj, historicoStr, msgAtual) {
  const safeFacts = JSON.stringify(factsObj || {}, null, 2);
  const safeHist = String(historicoStr || '');
  const safeMsg = String(msgAtual || '');

  return String(template || '')
    .replace(/\{FACTS_JSON\}/g, safeFacts)
    .replace(/\{HISTORICO\}/g, safeHist)
    .replace(/\{MENSAGEM_ATUAL\}/g, safeMsg);
}

function extractJsonObject(str) {
  const s = String(str || '').trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return null;
}

function safeParseAgentJson(raw) {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return { ok: false, data: null };

  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== 'object') return { ok: false, data: null };
    if (!Array.isArray(obj.messages)) return { ok: false, data: obj };
    return { ok: true, data: obj };
  } catch {
    return { ok: false, data: null };
  }
}

// ===== Delay humano =====
function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Delay “humano” baseado no tamanho do que o usuário mandou.
 * - base: 900–1800ms
 * - + por caractere (simula leitura): 18–45ms/char (capado)
 * - + jitter: 400–1600ms
 * - min 1.6s / max 9.5s (ajuste se quiser mais lento)
 */
async function humanDelayForInboundText(userText) {
  const t = String(userText || '');
  const chars = t.length;

  const base = randInt(900, 1800);
  const perChar = randInt(18, 45);
  const reading = Math.min(chars * perChar, 5200); // cap
  const jitter = randInt(400, 1600);

  let total = base + reading + jitter;

  // se msg for muito curta tipo "oi", ainda assim dá uma segurada mínima
  const minMs = 1600;
  const maxMs = 9500;

  if (total < minMs) total = minMs;
  if (total > maxMs) total = maxMs;

  await sleep(total);
}

// ===== Venice call =====
async function callVeniceChat({ apiKey, model, systemPromptRendered, userId }) {
  const url = 'https://api.venice.ai/api/v1/chat/completions';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPromptRendered },
      { role: 'user', content: 'Responda exatamente no formato JSON especificado.' },
    ],
    temperature: 0.7,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    user: userId || undefined,
    venice_parameters: {
      enable_web_search: 'off',
      include_venice_system_prompt: false,
      enable_web_citations: false,
      enable_web_scraping: false,
    },
    stream: false,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
    validateStatus: () => true,
  });

  return { status: r.status, data: r.data };
}

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

// ===== Login simples =====
app.get(['/','/login'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', (req, res) => {
  const { password } = req.body;
  const want = process.env.ADMIN_PASSWORD || '8065537Ncfp@';
  if (password === want) {
    req.session.loggedIn = true;
    return res.redirect('/admin/settings');
  }
  return res.status(401).send('Login inválido. <a href="/login">Tente novamente</a>');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===== Admin Settings =====
app.get('/admin/settings', checkAuth, async (req, res) => {
  try {
    const settings = await db.getBotSettings();
    const metaNumbers = await db.listMetaNumbers();
    res.render('settings', { settings, metaNumbers, ok: req.query.ok ? 1 : 0 });
  } catch {
    res.status(500).send('Erro ao carregar settings.');
  }
});

app.post('/admin/settings', checkAuth, async (req, res) => {
  try {
    await db.updateBotSettings(req.body || {});
    global.botSettings = await db.getBotSettings({ bypassCache: true });
    global.veniceConfig = {
      venice_api_key: global.botSettings.venice_api_key,
      venice_model: global.botSettings.venice_model,
      system_prompt: global.botSettings.system_prompt,
    };
    res.redirect('/admin/settings?ok=1');
  } catch {
    res.status(500).send('Erro ao salvar settings.');
  }
});

// ===== Admin Meta Numbers =====
app.post('/admin/settings/meta/save', checkAuth, async (req, res) => {
  try {
    const id = (req.body.id || '').trim();
    const payload = {
      phone_number_id: (req.body.phone_number_id || '').trim(),
      display_phone_number: (req.body.display_phone_number || '').trim(),
      access_token: (req.body.access_token || '').trim(),
      label: (req.body.label || '').trim(),
      active: !!req.body.active,
    };

    if (!payload.phone_number_id || !payload.access_token) {
      return res.status(400).send('phone_number_id e access_token são obrigatórios.');
    }

    if (id) await db.updateMetaNumber(id, payload);
    else await db.createMetaNumber(payload);

    res.redirect('/admin/settings?ok=1');
  } catch {
    res.status(500).send('Erro ao salvar número Meta.');
  }
});

app.post('/admin/settings/meta/delete', checkAuth, async (req, res) => {
  try {
    const id = (req.body.id || '').trim();
    if (id) await db.deleteMetaNumber(id);
    res.redirect('/admin/settings?ok=1');
  } catch {
    res.status(500).send('Erro ao remover número Meta.');
  }
});

// ===== Webhook verify (Meta) =====
app.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  try {
    const settings = await db.getBotSettings();
    const VERIFY_TOKEN = (settings?.contact_token || '').trim();

    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(500);
  }
});

// ===== Processor (IA + envio) =====
async function processInboundText({ wa_id, inboundPhoneNumberId, text }) {
  const st = getLead(wa_id);
  if (!st) return;

  const settings = global.botSettings || await db.getBotSettings();
  const veniceApiKey = (settings?.venice_api_key || '').trim();
  const veniceModel = (settings?.venice_model || '').trim();
  const systemPromptTpl = (settings?.system_prompt || '').trim();

  if (!veniceApiKey || !veniceModel || !systemPromptTpl) {
    await sendMessage(wa_id, 'Config incompleta no painel (venice key/model/prompt).', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  // delay “humano” ANTES de responder
  await humanDelayForInboundText(text);

  const facts = buildFactsJson(st, inboundPhoneNumberId);
  const historicoStr = buildHistoryString(st);
  const rendered = renderSystemPrompt(systemPromptTpl, facts, historicoStr, text);

  const venice = await callVeniceChat({
    apiKey: veniceApiKey,
    model: veniceModel,
    systemPromptRendered: rendered,
    userId: wa_id,
  });

  if (!venice || venice.status < 200 || venice.status >= 300) {
    await sendMessage(wa_id, 'Tive um erro aqui. Manda de novo?', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  const content = venice?.data?.choices?.[0]?.message?.content || '';
  const parsed = safeParseAgentJson(content);

  if (!parsed.ok) {
    await sendMessage(wa_id, 'Não entendi direito. Me manda de novo?', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  const agent = parsed.data;
  const outMessages = (agent.messages || [])
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!outMessages.length) return;

  for (let i = 0; i < outMessages.length; i++) {
    const msg = outMessages[i];

    // micro-delay entre bolhas (fica mais humano)
    if (i > 0) await new Promise(r => setTimeout(r, randInt(250, 750)));

    const r = await sendMessage(wa_id, msg, {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });

    if (r?.ok) {
      pushHistory(wa_id, 'assistant', msg, {
        kind: 'text',
        wamid: r.wamid || '',
        phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
      });
    }
  }
}

// ===== Webhook receiver (Meta) =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body || {};

  try {
    const entry = Array.isArray(body.entry) ? body.entry : [];

    for (const e of entry) {
      const changes = Array.isArray(e.changes) ? e.changes : [];

      for (const ch of changes) {
        const value = ch.value || {};
        const inboundPhoneNumberId = value?.metadata?.phone_number_id || null;

        // Acks/status
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          publishAck({
            wa_id: st.recipient_id || '',
            wamid: st.id || '',
            status: st.status || '',
            ts: Number(st.timestamp) * 1000 || Date.now(),
          });
        }

        // Mensagens inbound
        const msgs = Array.isArray(value.messages) ? value.messages : [];
        for (const m of msgs) {
          const wa_id = m.from;
          const wamid = m.id;
          const type = m.type;

          // salva phone_number_id do inbound (multi-número)
          try {
            const stLead = getLead(wa_id);
            if (stLead && inboundPhoneNumberId) stLead.meta_phone_number_id = inboundPhoneNumberId;
            if (inboundPhoneNumberId) rememberInboundMetaPhoneNumberId(wa_id, inboundPhoneNumberId);
          } catch {}

          // extrai texto
          let text = '';
          if (type === 'text') text = m.text?.body || '';
          else text = `[${type || 'msg'}]`;

          // ✅ ÚNICO LOG que fica
          console.log(`[${wa_id}] ${text}`);

          // memória + SSE inbound
          pushHistory(wa_id, 'user', text, { wamid, kind: type });

          publishMessage({
            dir: 'in',
            wa_id,
            wamid,
            kind: type,
            text,
            ts: Number(m.timestamp) * 1000 || Date.now(),
          });

          publishState({ wa_id, etapa: 'RECEBIDO', vars: { kind: type }, ts: Date.now() });

          // processa IA somente se for texto
          if (type === 'text') {
            processInboundText({
              wa_id,
              inboundPhoneNumberId,
              text,
            }).catch(() => {});
          }
        }
      }
    }
  } catch {
    // sem logs
  }
});

// ===== Start =====
(async () => {
  await bootstrapDb();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {});
})();

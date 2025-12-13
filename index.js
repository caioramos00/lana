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
    role, // "user" | "assistant" | "system"
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
}, 60 * 60 * 1000); // limpa 1x/h

// ===== Helpers (prompt render + parse JSON) =====
function buildHistoryString(st) {
  const hist = Array.isArray(st?.history) ? st.history : [];
  // formato simples e barato pro LLM
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

  // se vier só JSON, perfeito
  if (s.startsWith('{') && s.endsWith('}')) return s;

  // tenta extrair o primeiro objeto JSON de dentro do texto
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return s.slice(first, last + 1);
  }
  return null;
}

function safeParseAgentJson(raw) {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return { ok: false, reason: 'no-json-found', data: null };

  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not-an-object', data: null };
    if (!Array.isArray(obj.messages)) return { ok: false, reason: 'missing-messages-array', data: obj };
    return { ok: true, data: obj };
  } catch (e) {
    return { ok: false, reason: 'json-parse-error', error: e?.message || String(e), data: null };
  }
}

// ===== Venice call =====
async function callVeniceChat({ apiKey, model, systemPromptRendered, userId }) {
  const url = 'https://api.venice.ai/api/v1/chat/completions';

  // Observação:
  // - usamos response_format json_object pra forçar JSON
  // - include_venice_system_prompt: false pra não misturar prompt da Venice com o seu
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

  const started = now();

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
    validateStatus: () => true,
  });

  const tookMs = now() - started;

  return { status: r.status, data: r.data, tookMs, requestBodyPreview: body };
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

      console.log('[BOOT] DB ok + settings carregadas.');
      return;
    } catch (e) {
      attempt++;
      console.warn(`[BOOT] tentativa ${attempt} falhou:`, e?.message || e);
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
  } catch (e) {
    console.error('[AdminSettings][GET]', e?.message || e);
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
  } catch (e) {
    console.error('[AdminSettings][POST]', e?.message || e);
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
  } catch (e) {
    console.error('[AdminSettings][MetaSave]', e?.message || e);
    res.status(500).send('Erro ao salvar número Meta.');
  }
});

app.post('/admin/settings/meta/delete', checkAuth, async (req, res) => {
  try {
    const id = (req.body.id || '').trim();
    if (id) await db.deleteMetaNumber(id);
    res.redirect('/admin/settings?ok=1');
  } catch (e) {
    console.error('[AdminSettings][MetaDelete]', e?.message || e);
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
    const VERIFY_TOKEN = (settings?.contact_token || '').trim(); // (seu campo que renomeou pra verify token no UI)

    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (e) {
    console.error('[WEBHOOK][VERIFY][ERR]', e?.message || e);
    return res.sendStatus(500);
  }
});

// ===== Processor (IA + envio) =====
async function processInboundText({ wa_id, inboundPhoneNumberId, text, wamid, timestampMs }) {
  const st = getLead(wa_id);
  if (!st) return;

  // facts + histórico
  const facts = buildFactsJson(st, inboundPhoneNumberId);
  const historicoStr = buildHistoryString(st);

  const settings = global.botSettings || await db.getBotSettings();
  const veniceApiKey = (settings?.venice_api_key || '').trim();
  const veniceModel = (settings?.venice_model || '').trim();
  const systemPromptTpl = (settings?.system_prompt || '').trim();

  console.log(`[AI][START] wa_id=${wa_id} phone_number_id=${inboundPhoneNumberId || ''} model=${veniceModel || '(vazio)'}`);

  publishState({ wa_id, etapa: 'AI_START', vars: { model: veniceModel || '' }, ts: now() });

  if (!veniceApiKey || !veniceModel || !systemPromptTpl) {
    console.warn(`[AI][SKIP] settings incompletas (key=${!!veniceApiKey} model=${!!veniceModel} prompt=${!!systemPromptTpl})`);
    publishState({ wa_id, etapa: 'AI_SKIP_SETTINGS_INCOMPLETE', vars: {}, ts: now() });

    await sendMessage(wa_id, 'Config incompleta no painel (venice key/model/prompt).', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  const rendered = renderSystemPrompt(systemPromptTpl, facts, historicoStr, text);

  console.log(`[AI][PROMPT_RENDERED] len=${rendered.length} preview="${rendered.slice(0, 180).replace(/\s+/g,' ').trim()}..."`);
  publishState({ wa_id, etapa: 'AI_PROMPT_RENDERED', vars: { len: rendered.length }, ts: now() });

  // chamada Venice
  publishState({ wa_id, etapa: 'AI_REQUEST', vars: {}, ts: now() });

  let venice;
  try {
    // log request (sem vazar api key)
    console.log(`[AI][REQUEST] url=https://api.venice.ai/api/v1/chat/completions messages=2 response_format=json_object max_tokens=700`);

    venice = await callVeniceChat({
      apiKey: veniceApiKey,
      model: veniceModel,
      systemPromptRendered: rendered,
      userId: wa_id,
    });

    console.log(`[AI][HTTP] status=${venice.status} tookMs=${venice.tookMs}`);
    publishState({ wa_id, etapa: 'AI_HTTP', vars: { status: venice.status, tookMs: venice.tookMs }, ts: now() });

  } catch (e) {
    console.error(`[AI][ERROR] request failed: ${e?.message || e}`);
    publishState({ wa_id, etapa: 'AI_ERROR_REQUEST', vars: { error: e?.message || String(e) }, ts: now() });

    await sendMessage(wa_id, 'Deu ruim aqui rapidinho. Manda de novo?', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  if (!venice || venice.status < 200 || venice.status >= 300) {
    console.error(`[AI][HTTP_ERROR] status=${venice?.status} bodyPreview=${JSON.stringify(venice?.data || {}).slice(0, 600)}`);
    publishState({ wa_id, etapa: 'AI_HTTP_ERROR', vars: { status: venice?.status || 0 }, ts: now() });

    await sendMessage(wa_id, 'Tive um erro aqui. Manda de novo?', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  const content = venice?.data?.choices?.[0]?.message?.content || '';
  console.log(`[AI][RAW] preview="${String(content).slice(0, 350).replace(/\s+/g,' ').trim()}..."`);
  publishState({ wa_id, etapa: 'AI_RAW', vars: { chars: String(content).length }, ts: now() });

  const parsed = safeParseAgentJson(content);

  if (!parsed.ok) {
    console.error(`[AI][PARSE_FAIL] reason=${parsed.reason} err=${parsed.error || ''}`);
    publishState({ wa_id, etapa: 'AI_PARSE_FAIL', vars: { reason: parsed.reason }, ts: now() });

    await sendMessage(wa_id, 'Não entendi direito. Me manda de novo?', {
      meta_phone_number_id: inboundPhoneNumberId || null,
    });
    return;
  }

  const agent = parsed.data;
  console.log(`[AI][PARSE_OK] intent=${agent.intent_detectada} fase=${agent.proxima_fase} msgs=${(agent.messages || []).length}`);
  publishState({
    wa_id,
    etapa: 'AI_PARSE_OK',
    vars: { intent: agent.intent_detectada || '', fase: agent.proxima_fase || '' },
    ts: now()
  });

  // envia até 3 mensagens curtas (como o prompt define)
  const outMessages = (agent.messages || [])
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!outMessages.length) {
    console.warn('[AI][NO_MESSAGES] agent retornou JSON sem messages válidas');
    publishState({ wa_id, etapa: 'AI_NO_MESSAGES', vars: {}, ts: now() });
    return;
  }

  for (let i = 0; i < outMessages.length; i++) {
    const msg = outMessages[i];

    publishState({ wa_id, etapa: 'OUT_SEND_START', vars: { i: i + 1, total: outMessages.length }, ts: now() });
    console.log(`[AI][SEND] (${i + 1}/${outMessages.length}) -> "${msg.replace(/\s+/g,' ').slice(0, 200)}"`);

    try {
      const r = await sendMessage(wa_id, msg, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });

      console.log(`[AI][SEND_OK] (${i + 1}/${outMessages.length}) ok=${!!r?.ok} phone_number_id=${r?.phone_number_id || inboundPhoneNumberId || ''}`);
      publishState({ wa_id, etapa: 'OUT_SEND_OK', vars: { i: i + 1 }, ts: now() });

      if (r?.ok) {
        pushHistory(wa_id, 'assistant', msg, {
          kind: 'text',
          wamid: r.wamid || '',
          phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
        });
      }

    } catch (e) {
      console.warn(`[AI][SEND_FAIL] (${i + 1}/${outMessages.length}) err=${e?.message || e}`);
      publishState({ wa_id, etapa: 'OUT_SEND_FAIL', vars: { i: i + 1, error: e?.message || String(e) }, ts: now() });
      break;
    }

    // micro-delay entre bolhas (evita rate-limit e fica "natural")
    if (i < outMessages.length - 1) {
      await new Promise(r => setTimeout(r, 350));
    }
  }
}

// ===== Webhook receiver (Meta) =====
app.post('/webhook', async (req, res) => {
  // ACK rápido
  res.sendStatus(200);

  const body = req.body || {};
  let loggedFullPayload = false;

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
        if (msgs.length && !loggedFullPayload) {
          // LOG 1: payload COMPLETO recebido (apenas quando tem mensagens)
          console.log('[WEBHOOK][INBOUND][PAYLOAD_FULL]\n' + JSON.stringify(body, null, 2));
          loggedFullPayload = true;
        }

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

          // LOG 2: formato curto
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

          // ✅ Agora: processa IA somente se for texto
          if (type === 'text') {
            // roda em "background" (sem travar webhook)
            processInboundText({
              wa_id,
              inboundPhoneNumberId,
              text,
              wamid,
              timestampMs: Number(m.timestamp) * 1000 || Date.now(),
            }).catch((err) => {
              console.error(`[AI][FATAL] wa_id=${wa_id} err=${err?.message || err}`);
              publishState({ wa_id, etapa: 'AI_FATAL', vars: { error: err?.message || String(err) }, ts: now() });
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[WEBHOOK][POST][ERR]', err?.message || err);
  }
});

// ===== Start =====
(async () => {
  await bootstrapDb();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`[✅ Servidor rodando na porta ${PORT}]`));
})();

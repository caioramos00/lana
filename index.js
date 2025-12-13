// index.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db.js');
const { rememberInboundMetaPhoneNumberId } = require('./senders');
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
    st = { wa_id: key, history: [], expiresAt: now() + TTL_MS };
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

// ===== Login simples (reaproveita public/login.html) =====
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
    // recarrega cache global
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
    const VERIFY_TOKEN = (settings?.contact_token || '').trim();

    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (e) {
    console.error('[WEBHOOK][VERIFY][ERR]', e?.message || e);
    return res.sendStatus(500);
  }
});

// ===== Webhook receiver (Meta) =====
app.post('/webhook', async (req, res) => {
  // ACK rápido
  res.sendStatus(200);

  const body = req.body || {};
  try {
    const entry = Array.isArray(body.entry) ? body.entry : [];
    for (const e of entry) {
      const changes = Array.isArray(e.changes) ? e.changes : [];
      for (const ch of changes) {
        const value = ch.value || {};
        const inboundPhoneNumberId = value?.metadata?.phone_number_id || null;

        // statuses (acks)
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          publishAck({
            wa_id: st.recipient_id || '',
            wamid: st.id || '',
            status: st.status || '',
            ts: Number(st.timestamp) * 1000 || Date.now(),
          });
        }

        // messages (inbound)
        const msgs = Array.isArray(value.messages) ? value.messages : [];
        for (const m of msgs) {
          const wa_id = m.from;
          try {
            const stLead = getLead(wa_id);
            if (stLead && inboundPhoneNumberId) stLead.meta_phone_number_id = inboundPhoneNumberId;
            if (inboundPhoneNumberId) rememberInboundMetaPhoneNumberId(wa_id, inboundPhoneNumberId);
          } catch {}
          const wamid = m.id;
          const type = m.type;

          let text = '';
          if (type === 'text') text = m.text?.body || '';
          else text = `[${type || 'msg'}]`;

          pushHistory(wa_id, 'user', text, { wamid, kind: type });

          publishMessage({
            dir: 'in',
            wa_id,
            wamid,
            kind: type,
            text,
            ts: Number(m.timestamp) * 1000 || Date.now(),
          });

          // placeholder de estado (só pra você ver no SSE/painel)
          publishState({ wa_id, etapa: 'RECEBIDO', vars: { kind: type }, ts: Date.now() });
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

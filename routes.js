'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { downloadMetaMediaToTempFile } = require('./senders');
const { transcribeAudioOpenAI } = require('./transcribe');
const { createPaymentsModule } = require('./payments/payment-module');

// ✅ NOVO: lookup Ads/Campaign
const { resolveCampaignFromInbound } = require('./meta_ads');

function safeTsMsFromSeconds(tsSec) {
  const n = Number(tsSec);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  const ms = n * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
}

function collapseOneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function verifyMetaSignature(req, appSecret) {
  // Header vem como: "sha256=<hex>"
  const sig = String(req.get('X-Hub-Signature-256') || '').trim();
  if (!sig || !sig.startsWith('sha256=')) return false;

  const provided = sig.slice('sha256='.length);

  // ✅ rawBody vem do index.js (express.json verify)
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');

  return timingSafeEqualHex(provided, expected);
}

function getInboundContact(value, wa_id) {
  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  return (
    contacts.find(c => String(c?.wa_id || '').trim() === String(wa_id || '').trim()) ||
    contacts[0] ||
    null
  );
}

// Extrai “texto útil” para IA/histórico em vários tipos (text, interactive, button, etc.)
function extractInboundText(m) {
  const type = String(m?.type || '').trim();

  if (type === 'text') return m?.text?.body || '';

  if (type === 'interactive') {
    const it = m?.interactive || {};
    const itType = String(it?.type || '').trim();

    if (itType === 'button_reply') {
      const t = it?.button_reply?.title || it?.button_reply?.id || '';
      return t ? `[btn] ${t}` : '[interactive]';
    }

    if (itType === 'list_reply') {
      const t = it?.list_reply?.title || it?.list_reply?.id || '';
      return t ? `[list] ${t}` : '[interactive]';
    }

    return '[interactive]';
  }

  if (type === 'button') {
    const t = m?.button?.text || m?.button?.payload || '';
    return t ? `[btn] ${t}` : '[button]';
  }

  if (type === 'reaction') {
    const emoji = m?.reaction?.emoji || '';
    const to = m?.reaction?.message_id || '';
    return `[reaction] ${emoji}${to ? ` -> ${to}` : ''}`.trim();
  }

  if (type === 'image') return m?.image?.caption ? collapseOneLine(m.image.caption) : '[image]';
  if (type === 'video') return m?.video?.caption ? collapseOneLine(m.video.caption) : '[video]';
  if (type === 'document') {
    return m?.document?.caption
      ? collapseOneLine(m.document.caption)
      : `[document] ${m?.document?.filename || ''}`.trim();
  }

  if (type === 'audio') return '[audio]';
  if (type === 'sticker') return '[sticker]';

  if (type === 'location') {
    const lat = m?.location?.latitude;
    const lng = m?.location?.longitude;
    return `[location] ${lat ?? ''},${lng ?? ''}`.trim();
  }

  return `[${type || 'msg'}]`;
}

function registerRoutes(app, {
  db,
  lead,
  rememberInboundMetaPhoneNumberId,
  publishMessage,
  publishAck,
  publishState,
} = {}) {

  function checkAuth(req, res, next) {
    if (req.session?.loggedIn) return next();
    return res.redirect('/login');
  }

  const payments = createPaymentsModule({
    db,
    lead,
    publishState,
    logger: console,
  });

  // ✅ NOVO: dedupe simples do lookup por (wa_id + ad_id)
  const adsLookupSeen = new Map(); // key -> ts_ms
  const ADS_LOOKUP_TTL_MS = 10 * 60 * 1000; // 10min

  function adsLookupShouldRun(wa_id, ad_id) {
    const key = `${String(wa_id || '').trim()}:${String(ad_id || '').trim()}`;
    const now = Date.now();
    const last = adsLookupSeen.get(key);
    if (last && (now - last) < ADS_LOOKUP_TTL_MS) return false;
    adsLookupSeen.set(key, now);

    // limpeza simples
    if (adsLookupSeen.size > 5000) {
      for (const [k, ts] of adsLookupSeen.entries()) {
        if (now - ts > ADS_LOOKUP_TTL_MS) adsLookupSeen.delete(k);
      }
    }
    return true;
  }

  async function resolveAdsToken({ inboundPhoneNumberId, settingsNow }) {
    // 1) settings (preferível)
    let token =
      String(settingsNow?.meta_ads_access_token || '').trim()
      || String(settingsNow?.graph_api_access_token || '').trim()
      || '';

    // 2) env fallback
    if (!token) token = String(process.env.META_ADS_ACCESS_TOKEN || '').trim();

    // 3) fallback opcional: token salvo no número Meta (pode funcionar ou não para Ads)
    if (!token && inboundPhoneNumberId && db?.listMetaNumbers) {
      try {
        const list = await db.listMetaNumbers();
        const found = Array.isArray(list)
          ? list.find(n => String(n?.phone_number_id || '').trim() === String(inboundPhoneNumberId || '').trim())
          : null;
        const t = String(found?.access_token || '').trim();
        if (t) token = t;
      } catch { }
    }

    return token;
  }

  async function runAdsLookupAndLog({ wa_id, wamid, inboundPhoneNumberId, m }) {
    try {
      const referral = m?.referral || null;
      if (!referral) return;

      const sourceType = String(referral?.source_type || '').toLowerCase();
      const adId = String(referral?.source_id || '').trim();

      if (!adId || sourceType !== 'ad') return;

      if (!adsLookupShouldRun(wa_id, adId)) return;

      const settingsNow = global.botSettings || await db.getBotSettings();

      const token = await resolveAdsToken({ inboundPhoneNumberId, settingsNow });

      const settingsForLookup = {
        ...(settingsNow || {}),
        meta_ads_access_token: token, // garante que resolveCampaignFromInbound tenha o token
      };

      console.log('[META][ADS][LOOKUP][START]', {
        wa_id,
        wamid,
        inboundPhoneNumberId: inboundPhoneNumberId || null,
        ad_id: adId,
        source_type: sourceType,
      });

      const out = await resolveCampaignFromInbound(
        { referral, message: m }, // inboundEvent compatível com seu extractor
        settingsForLookup,
        { logger: console }
      );

      if (out) {
        try {
          console.log('[LEAD][STORE_ID][LOOKUP]', lead?.__store_id, { wa_id });

          const stLead = lead?.getLead?.(wa_id);
          console.log('[LEAD][STATE][BEFORE_SET]', lead?.__store_id, { wa_id, has_meta: !!stLead?.meta_ads, has_last: !!stLead?.last_ads_lookup });

          if (stLead) {
            stLead.meta_ads = out;
            stLead.meta_ads_updated_ts = Date.now();
            stLead.meta_ads_source = 'graph_api';
          }

          console.log('[LEAD][STATE][AFTER_SET]', lead?.__store_id, { wa_id, has_meta: !!stLead?.meta_ads, has_last: !!stLead?.last_ads_lookup });

        } catch { }
      }

      if (!out) {
        console.log('[META][ADS][LOOKUP][NO_DATA]', {
          wa_id,
          wamid,
          ad_id: adId,
        });
        return;
      }

      // opcional: salva no state do lead pra você debugar depois
      try {
        const stLead = lead?.getLead?.(wa_id);
        if (stLead) {
          stLead.last_ads_lookup = {
            ...out,
            looked_up_at_iso: new Date().toISOString(),
            looked_up_ts_ms: Date.now(),
            wa_id,
            wamid,
          };
        }
      } catch { }

      console.log('[META][ADS][LOOKUP][OK]');
      console.log(JSON.stringify({
        wa_id,
        wamid,
        inboundPhoneNumberId: inboundPhoneNumberId || null,
        ...out,
      }, null, 2));
    } catch (e) {
      console.log('[META][ADS][LOOKUP][ERR]', {
        wa_id,
        wamid,
        message: e?.message || 'err',
      });
    }
  }

  // ---------- AUTH/UI ----------
  app.get(['/', '/login'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

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

      global.veltraxConfig = {
        api_base_url: (global.botSettings.veltrax_api_base_url || 'https://api.veltraxpay.com').trim(),
        client_id: (global.botSettings.veltrax_client_id || '').trim(),
        client_secret: (global.botSettings.veltrax_client_secret || '').trim(),
        callback_base_url: (global.botSettings.veltrax_callback_base_url || '').trim(),
        webhook_path: (global.botSettings.veltrax_webhook_path || '/webhook/veltrax').trim(),
      };

      global.veniceConfig = {
        venice_api_key: global.botSettings.venice_api_key,
        venice_model: global.botSettings.venice_model,
        system_prompt: global.botSettings.system_prompt,
      };

      global.transcribeConfig = {
        enabled: (global.botSettings.openai_transcribe_enabled === undefined || global.botSettings.openai_transcribe_enabled === null)
          ? true
          : !!global.botSettings.openai_transcribe_enabled,
        model: String(global.botSettings.openai_transcribe_model || '').trim() || 'whisper-1',
        language: String(global.botSettings.openai_transcribe_language || '').trim(),
        prompt: String(global.botSettings.openai_transcribe_prompt || '').trim(),
        timeout_ms: Number(global.botSettings.openai_transcribe_timeout_ms) || 60000,
      };

      if (lead && typeof lead.updateConfig === 'function') {
        lead.updateConfig({
          inboundDebounceMinMs: global.botSettings.inbound_debounce_min_ms,
          inboundDebounceMaxMs: global.botSettings.inbound_debounce_max_ms,
          inboundMaxWaitMs: global.botSettings.inbound_max_wait_ms,

          maxMsgs: global.botSettings.lead_max_msgs,
          ttlMs: global.botSettings.lead_ttl_ms,
          lateJoinWindowMs: global.botSettings.lead_late_join_window_ms,
          previewTextMaxLen: global.botSettings.lead_preview_text_max_len,
          debugDebounce: global.botSettings.lead_debug_debounce,
        });
      }

      res.redirect('/admin/settings?ok=1');
    } catch {
      res.status(500).send('Erro ao salvar settings.');
    }
  });

  // ---------- META NUMBERS ----------
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

  // ---------- WEBHOOK VERIFY (GET) ----------
  app.get('/webhook', (req, res) => {
    try {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || '';

      if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
        return res.status(200).send(String(challenge || ''));
      }
      return res.sendStatus(403);
    } catch {
      return res.sendStatus(403);
    }
  });

  // ---------- WEBHOOK (POST) ----------
  app.post('/webhook', async (req, res) => {
    // 1) valida assinatura (antes de responder 200)
    try {
      const APP_SECRET = process.env.META_APP_SECRET || '';
      if (APP_SECRET) {
        const ok = verifyMetaSignature(req, APP_SECRET);
        if (!ok) return res.sendStatus(401);
      }
    } catch {
      return res.sendStatus(401);
    }

    // 2) ACK imediato
    res.sendStatus(200);

    const body = req.body || {};

    function mergeTranscriptIntoAudioHistory({ wa_id, wamid, mediaId, transcriptText }) {
      try {
        const stLead = lead?.getLead?.(wa_id);
        const hist = Array.isArray(stLead?.history) ? stLead.history : null;
        if (!hist) return { ok: false, reason: 'no-history' };

        const targetWamid = String(wamid || '').trim();
        if (!targetWamid) return { ok: false, reason: 'missing-wamid' };

        for (let i = hist.length - 1; i >= 0; i--) {
          const h = hist[i];
          if (!h) continue;

          const hWamid = String(h.wamid || '').trim();
          if (hWamid !== targetWamid) continue;

          const cleanTr = collapseOneLine(transcriptText);
          const combined = cleanTr ? `[audio] ${cleanTr}` : `[audio]`;

          h.text = combined;
          h.is_transcript = true;
          h.transcript_text = cleanTr;
          h.source_kind = 'audio';
          h.source_wamid = targetWamid;
          h.source_media_id = String(mediaId || '').trim() || null;

          return { ok: true, combinedText: combined };
        }

        return { ok: false, reason: 'audio-entry-not-found' };
      } catch (e) {
        return { ok: false, reason: 'exception', message: e?.message };
      }
    }

    try {
      const entry = Array.isArray(body.entry) ? body.entry : [];

      for (const e of entry) {
        const changes = Array.isArray(e.changes) ? e.changes : [];

        for (const ch of changes) {
          const value = ch?.value || {};
          const inboundPhoneNumberId = value?.metadata?.phone_number_id || null;

          // statuses
          const statuses = Array.isArray(value.statuses) ? value.statuses : [];
          for (const st of statuses) {
            try {
              publishAck?.({
                wa_id: st.recipient_id || '',
                wamid: st.id || '',
                status: st.status || '',
                ts: safeTsMsFromSeconds(st.timestamp),
              });
            } catch { }
          }

          // messages
          const msgs = Array.isArray(value.messages) ? value.messages : [];
          for (const m of msgs) {
            const wa_id = String(m?.from || '').trim();
            const wamid = String(m?.id || '').trim();
            const type = String(m?.type || '').trim();

            if (!wa_id || !wamid) continue;

            // dedupe
            try {
              if (lead && typeof lead.markInboundWamidSeen === 'function') {
                const r = lead.markInboundWamidSeen(wa_id, wamid);
                if (r?.duplicate) continue;
              }
            } catch { }

            // ✅ NOVO: se tiver referral, roda lookup em paralelo (não bloqueia)
            if (m?.referral) {
              try {
                const st = lead?.getLead?.(wa_id);
                if (st) {
                  // evita iniciar vários lookups em paralelo pro mesmo lead
                  if (!st.meta_ads_inflight) {
                    st.meta_ads_inflight = Promise.resolve()
                      .then(() => runAdsLookupAndLog({ wa_id, wamid, inboundPhoneNumberId, m }))
                      .catch(() => null)
                      .finally(() => {
                        try { st.meta_ads_inflight = null; } catch { }
                      });
                  }
                } else {
                  // fallback: roda sem armazenar inflight
                  runAdsLookupAndLog({ wa_id, wamid, inboundPhoneNumberId, m }).catch?.(() => { });
                }
              } catch {
                (async () => { await runAdsLookupAndLog({ wa_id, wamid, inboundPhoneNumberId, m }); })();
              }
            }

            // state/meta
            let stLead = null;
            try {
              stLead = lead?.getLead?.(wa_id);

              if (stLead && inboundPhoneNumberId) stLead.meta_phone_number_id = inboundPhoneNumberId;
              if (inboundPhoneNumberId) rememberInboundMetaPhoneNumberId?.(wa_id, inboundPhoneNumberId);

              // ✅ CAPTURA do PRIMEIRO inbound
              if (stLead && !stLead.first_inbound_payload) {
                const contact = getInboundContact(value, wa_id);

                const snapshot = {
                  captured_at_iso: new Date().toISOString(),
                  captured_ts_ms: Date.now(),
                  wa_id,
                  wamid,
                  type,
                  inboundPhoneNumberId: inboundPhoneNumberId || null,
                  text_body: type === 'text' ? (m?.text?.body || '') : null,
                  referral: m?.referral || null,
                  context: m?.context || null,
                  contact: contact || null,
                  metadata: value?.metadata || null,
                  message: m || null,
                };

                stLead.first_inbound_payload = snapshot;
                stLead.first_inbound_captured_ts = snapshot.captured_ts_ms;

                console.log('[INBOUND][FIRST_MESSAGE_CAPTURED]');
                console.log(JSON.stringify(snapshot, null, 2));
              }
            } catch { }

            const extracted = extractInboundText(m);
            const textForLog = extracted || `[${type || 'msg'}]`;
            console.log(`[${wa_id}] ${textForLog}`);

            try { lead?.pushHistory?.(wa_id, 'user', textForLog, { wamid, kind: type }); } catch { }

            try {
              publishMessage?.({
                dir: 'in',
                wa_id,
                wamid,
                kind: type,
                text: textForLog,
                ts: safeTsMsFromSeconds(m?.timestamp),
              });
            } catch { }

            try { publishState?.({ wa_id, etapa: 'RECEBIDO', vars: { kind: type }, ts: Date.now() }); } catch { }

            const shouldEnqueueAsText = type === 'text' || type === 'interactive' || type === 'button' || type === 'reaction';
            if (shouldEnqueueAsText) {
              try {
                const clean = collapseOneLine(textForLog);
                if (clean) {
                  lead?.enqueueInboundText?.({ wa_id, inboundPhoneNumberId, text: clean, wamid });
                }
              } catch { }
            }

            if (type === 'audio') {
              const mediaId = String(m?.audio?.id || '').trim();
              if (!mediaId) continue;

              (async () => {
                let tmp = null;

                try {
                  const settingsNow = await db.getBotSettings();

                  const sttEnabled =
                    settingsNow?.openai_transcribe_enabled === undefined || settingsNow?.openai_transcribe_enabled === null
                      ? true
                      : !!settingsNow.openai_transcribe_enabled;

                  if (!sttEnabled) {
                    console.log('[AUDIO][TRANSCRIBE][SKIP]', { wa_id, reason: 'disabled' });
                    publishState?.({ wa_id, etapa: 'AUDIO_TRANSCRIBE_DISABLED', vars: {}, ts: Date.now() });
                    return;
                  }

                  const dl = await downloadMetaMediaToTempFile(wa_id, mediaId, {
                    meta_phone_number_id: inboundPhoneNumberId || null,
                  });

                  tmp = dl?.filePath || null;

                  const tr = await transcribeAudioOpenAI({ filePath: tmp, settings: settingsNow });

                  if (!tr?.ok) {
                    console.log('[AUDIO][TRANSCRIBE][FAIL]', { wa_id, reason: tr?.reason });
                    publishState?.({ wa_id, etapa: 'AUDIO_TRANSCRIBE_FAIL', vars: { reason: tr?.reason || '' }, ts: Date.now() });
                    return;
                  }

                  const transcriptText = collapseOneLine(tr.text);
                  if (!transcriptText) {
                    console.log('[AUDIO][TRANSCRIBE][FAIL]', { wa_id, reason: 'empty-transcript' });
                    publishState?.({ wa_id, etapa: 'AUDIO_TRANSCRIBE_FAIL', vars: { reason: 'empty-transcript' }, ts: Date.now() });
                    return;
                  }

                  const merged = mergeTranscriptIntoAudioHistory({ wa_id, wamid, mediaId, transcriptText });
                  if (!merged?.ok) console.log('[AUDIO][TRANSCRIBE][MERGE_FAIL]', { wa_id, reason: merged?.reason });

                  const transcriptWamid = `${wamid}:transcript`;

                  publishMessage?.({
                    dir: 'in',
                    wa_id,
                    wamid: transcriptWamid,
                    kind: 'text',
                    text: transcriptText,
                    ts: Date.now(),
                    meta: { is_transcript: true, source_kind: 'audio', source_wamid: wamid },
                  });

                  publishState?.({
                    wa_id,
                    etapa: 'AUDIO_TRANSCRIBE_OK',
                    vars: { model: tr.model || '', source_wamid: wamid },
                    ts: Date.now(),
                  });

                  const combinedInbound = collapseOneLine(`[audio] ${transcriptText}`);
                  lead?.enqueueInboundText?.({ wa_id, inboundPhoneNumberId, text: combinedInbound, wamid });
                } catch (e) {
                  console.log('[AUDIO][TRANSCRIBE][ERR]', { wa_id, message: e?.message });
                  publishState?.({ wa_id, etapa: 'AUDIO_TRANSCRIBE_ERR', vars: { message: e?.message || '' }, ts: Date.now() });
                } finally {
                  if (tmp) {
                    try { fs.unlinkSync(tmp); } catch { }
                  }
                }
              })();
            }
          }
        }
      }
    } catch {
      // silencioso
    }
  });

  // ---------- PAYMENT WEBHOOKS ----------
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

  for (const webhookPath of getVeltraxWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('veltrax'));
  }
  for (const webhookPath of getRapdynWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('rapdyn'));
  }
  for (const webhookPath of getZoompagWebhookPaths()) {
    app.post(webhookPath, payments.makeExpressWebhookHandler('zoompag'));
  }
}

module.exports = { registerRoutes };

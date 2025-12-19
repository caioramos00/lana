const path = require('path');
const axios = require('axios');
const fs = require('fs');

let FormData = null;
try { FormData = require('form-data'); } catch { /* ok */ }

const { downloadMetaMediaToTempFile } = require('./senders');
const { transcribeAudioOpenAI } = require('./transcribe');

function registerRoutes(app, {
  db,
  lead,
  rememberInboundMetaPhoneNumberId,
  publishMessage,
  publishAck,
  publishState,
  ai,
} = {}) {
  function checkAuth(req, res, next) {
    if (req.session?.loggedIn) return next();
    return res.redirect('/login');
  }

  function collapseOneLine(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function mergeTranscriptIntoAudioHistory({ wa_id, wamid, mediaId, transcriptText }) {
    try {
      const stLead = lead?.getLead?.(wa_id);
      const hist = Array.isArray(stLead?.history) ? stLead.history : null;
      if (!hist) return { ok: false, reason: 'no-history' };

      const targetWamid = String(wamid || '').trim();
      if (!targetWamid) return { ok: false, reason: 'missing-wamid' };

      // procura de trás pra frente (mais provável ser o último áudio desse wamid)
      for (let i = hist.length - 1; i >= 0; i--) {
        const h = hist[i];
        if (!h) continue;

        const hWamid = String(h.wamid || '').trim();
        if (hWamid !== targetWamid) continue;

        // achou a entrada do áudio: transforma em uma linha só
        const cleanTr = collapseOneLine(transcriptText);
        const combined = cleanTr ? `[audio] ${cleanTr}` : `[audio]`;

        h.text = combined;

        // marcações úteis (opcional)
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
        language: String(global.botSettings.openai_transcribe_language || '').trim(), // '' => autodetect
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

  // -------------------- VELTRAX WEBHOOK --------------------
  function getVeltraxWebhookPaths() {
    const p = String(global.veltraxConfig?.webhook_path || '/webhook/veltrax').trim() || '/webhook/veltrax';
    // segurança: registra também o default
    const list = new Set(['/webhook/veltrax', p]);
    return [...list];
  }

  for (const webhookPath of getVeltraxWebhookPaths()) {
    app.post(webhookPath, async (req, res) => {
      res.sendStatus(200);

      try {
        const payload = req.body || {};
        const row = await db.updateVeltraxDepositFromWebhook(payload);

        // log mínimo
        const tid = payload?.transaction_id || payload?.transactionId || row?.transaction_id || '';
        const ext = payload?.external_id || payload?.externalId || row?.external_id || '';
        const st = payload?.status || row?.status || '';
        console.log('[VELTRAX][WEBHOOK]', { status: st, transaction_id: tid, external_id: ext });

        if (row?.wa_id && String(st).toUpperCase() === 'COMPLETED') {
          publishState?.({
            wa_id: row.wa_id,
            etapa: 'VELTRAX_COMPLETED',
            vars: {
              offer_id: row.offer_id,
              amount: Number(row.amount),
              external_id: row.external_id,
              transaction_id: row.transaction_id,
            },
            ts: Date.now(),
          });

          try {
            if (lead && typeof lead.markPaymentCompleted === 'function') {
              lead.markPaymentCompleted(row.wa_id, {
                provider: 'veltrax',
                offer_id: row.offer_id,
                amount: Number(row.amount),
                external_id: row.external_id,
                transaction_id: row.transaction_id,
              });
            }
          } catch { }
        }
      } catch (e) {
        console.log('[VELTRAX][WEBHOOK][ERR]', { message: e?.message });
      }
    });
  }

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

          const statuses = Array.isArray(value.statuses) ? value.statuses : [];
          for (const st of statuses) {
            publishAck({
              wa_id: st.recipient_id || '',
              wamid: st.id || '',
              status: st.status || '',
              ts: Number(st.timestamp) * 1000 || Date.now(),
            });
          }

          const msgs = Array.isArray(value.messages) ? value.messages : [];
          for (const m of msgs) {
            const wa_id = m.from;
            const wamid = m.id;
            const type = m.type;

            // ✅ DEDUPE AQUI (entrada)
            if (lead && typeof lead.markInboundWamidSeen === 'function') {
              const r = lead.markInboundWamidSeen(wa_id, wamid);
              if (r?.duplicate) {
                continue;
              }
            }

            try {
              const stLead = lead.getLead(wa_id);
              if (stLead && inboundPhoneNumberId) stLead.meta_phone_number_id = inboundPhoneNumberId;
              if (inboundPhoneNumberId) rememberInboundMetaPhoneNumberId(wa_id, inboundPhoneNumberId);
            } catch { }

            let text = '';
            if (type === 'text') text = m.text?.body || '';
            else text = `[${type || 'msg'}]`;

            console.log(`[${wa_id}] ${text}`);

            // histórico “cru” do evento recebido
            lead.pushHistory(wa_id, 'user', text, { wamid, kind: type });

            publishMessage({
              dir: 'in',
              wa_id,
              wamid,
              kind: type,
              text,
              ts: Number(m.timestamp) * 1000 || Date.now(),
            });

            publishState({ wa_id, etapa: 'RECEBIDO', vars: { kind: type }, ts: Date.now() });

            if (type === 'text') {
              lead.enqueueInboundText({
                wa_id,
                inboundPhoneNumberId,
                text,
                wamid,
              });
            }

            if (type === 'audio') {
              const mediaId = String(m.audio?.id || '').trim();

              // se não tiver mediaId, não tem o que transcrever
              if (mediaId) {
                (async () => {
                  let tmp = null;
                  try {
                    const settingsNow = await db.getBotSettings();

                    const sttEnabled =
                      (settingsNow?.openai_transcribe_enabled === undefined || settingsNow?.openai_transcribe_enabled === null)
                        ? true
                        : !!settingsNow.openai_transcribe_enabled;

                    if (!sttEnabled) {
                      console.log('[AUDIO][TRANSCRIBE][SKIP]', { wa_id, reason: 'disabled' });
                      publishState?.({ wa_id, etapa: 'AUDIO_TRANSCRIBE_DISABLED', vars: {}, ts: Date.now() });
                      return;
                    }

                    // baixa áudio pra temp
                    const dl = await downloadMetaMediaToTempFile(wa_id, mediaId, {
                      meta_phone_number_id: inboundPhoneNumberId || null,
                    });

                    tmp = dl?.filePath || null;

                    // transcreve
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

                    // ✅ NOVO: transforma "USER: [audio]" em "USER: [audio] <transcrição>" (uma linha só)
                    const merged = mergeTranscriptIntoAudioHistory({
                      wa_id,
                      wamid,
                      mediaId,
                      transcriptText,
                    });

                    if (!merged?.ok) {
                      console.log('[AUDIO][TRANSCRIBE][MERGE_FAIL]', { wa_id, reason: merged?.reason });
                      // fallback: se não achou a entrada pra editar, ao menos não cria 2 linhas no histórico.
                      // (mantém só o [audio] já existente, e segue com inbound do transcript)
                    }

                    // (mantém um wamid derivado só pro SSE/debug, sem mexer no reply threading)
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

                    // ✅ NOVO: inbound para IA também vai com tag + transcrição numa linha (e usa wamid real)
                    const combinedInbound = `[audio] ${transcriptText}`.trim();

                    lead.enqueueInboundText({
                      wa_id,
                      inboundPhoneNumberId,
                      text: combinedInbound,
                      wamid, // usa o wamid REAL do áudio (evita reply_to_wamid inválido)
                    });
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
      }
    } catch {
      // sem logs
    }
  });

  const originalOnFlush = app.locals.__onFlushProxy;
}

module.exports = { registerRoutes };

const path = require('path');
const axios = require('axios');
const fs = require('fs');

let FormData = null;
try { FormData = require('form-data'); } catch { /* ok */ }

const { downloadMetaMediaToTempFile } = require('./senders');

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
          // avisa o sistema (você decide o que faz depois)
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

          // se existir método no lead, marca como pago
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
        // sem spam de log
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

  async function transcribeAudioOpenAI({ filePath, settings }) {
    const apiKey = String(settings?.openai_api_key || '').trim();
    if (!apiKey) return { ok: false, reason: 'missing-openai-api-key' };
    if (!FormData) return { ok: false, reason: 'missing-form-data' };

    const enabled =
      (settings?.openai_transcribe_enabled === undefined || settings?.openai_transcribe_enabled === null)
        ? true
        : !!settings.openai_transcribe_enabled;

    if (!enabled) return { ok: false, reason: 'transcribe-disabled' };

    const model = String(settings?.openai_transcribe_model || '').trim() || 'whisper-1';
    const language = String(settings?.openai_transcribe_language || '').trim(); // '' => autodetect (não envia)
    const prompt = String(settings?.openai_transcribe_prompt || '').trim();     // '' => não envia
    const timeoutMsRaw = Number(settings?.openai_transcribe_timeout_ms);
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 60000;

    const url = 'https://api.openai.com/v1/audio/transcriptions';

    const form = new FormData();
    form.append('model', model);
    form.append('file', fs.createReadStream(filePath));

    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);

    form.append('response_format', 'json');

    const r = await axios.post(url, form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (r.status < 200 || r.status >= 300) {
      const body = r.data ? JSON.stringify(r.data).slice(0, 800) : '';
      return { ok: false, reason: `openai-http-${r.status}`, body };
    }

    const text = String(r.data?.text || '').trim();
    if (!text) return { ok: false, reason: 'empty-transcript' };
    return { ok: true, text, model };
  }

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
                // Se quiser logar:
                // console.log(`[${wa_id}] DUP inbound wamid=${wamid} type=${type}`);
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

                    // cria um wamid "derivado" pra não ser excluído pelo excludeWamids do batch do áudio
                    const transcriptWamid = `${wamid}:transcript`;

                    // registra no histórico como texto (transcrição)
                    const transcriptText = tr.text;

                    lead.pushHistory(wa_id, 'user', transcriptText, {
                      wamid: transcriptWamid,
                      kind: 'text',
                      is_transcript: true,
                      source_kind: 'audio',
                      source_wamid: wamid,
                      source_media_id: mediaId,
                    });

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

                    lead.enqueueInboundText({
                      wa_id,
                      inboundPhoneNumberId,
                      text: transcriptText,
                      wamid: transcriptWamid,
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

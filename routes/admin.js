'use strict';

const path = require('path');
const { checkAuth } = require('./middlewares');

function registerAdminRoutes(app, {
  db,
  lead,
  chatIndex,
} = {}) {
  app.get(['/', '/login'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

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

  app.get('/admin/chats', checkAuth, (req, res) => {
    return res.sendFile(path.join(__dirname, '..', 'public', 'chats.html'));
  });

  app.get('/admin/api/chats', checkAuth, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(10000, Number(req.query.limit) || 5000));
      const chats = (chatIndex && typeof chatIndex.list === 'function')
        ? chatIndex.list({ limit })
        : [];
      return res.json({ ok: true, chats });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'err' });
    }
  });

  app.get('/admin/api/chats/:wa_id/messages', checkAuth, (req, res) => {
    try {
      const wa_id = String(req.params.wa_id || '').trim();
      if (!wa_id) return res.json({ ok: true, wa_id: '', title: '', messages: [] });

      try { chatIndex?.ensureKnown?.(wa_id); } catch { }

      const st = lead?.getLead?.(wa_id);
      const contact = st?.first_inbound_payload?.contact || null;
      const title = (
        (contact?.profile?.name || '').trim() ||
        (contact?.name?.formatted_name || '').trim() ||
        wa_id
      );

      const hist = Array.isArray(st?.history) ? st.history : [];
      const messages = hist.map((m) => ({
        role: String(m?.role || '').trim() || 'system',
        text: String(m?.text || ''),
        ts: m?.ts || null,
        ts_ms: Number.isFinite(m?.ts_ms) ? m.ts_ms : null,
        kind: String(m?.kind || 'text'),
        wamid: String(m?.wamid || ''),
        audio_text: String(m?.audio_text || ''),
        meta: m?.meta || undefined,
      }));

      return res.json({ ok: true, wa_id, title, messages });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'err' });
    }
  });
}

module.exports = { registerAdminRoutes };

const path = require('path');

function registerRoutes(app, {
    db,
    lead,
    rememberInboundMetaPhoneNumberId,
    publishMessage,
    publishAck,
    publishState,

    // ai engine (vamos chamar ai._handleInboundBlock)
    ai,
} = {}) {
    function checkAuth(req, res, next) {
        if (req.session?.loggedIn) return next();
        return res.redirect('/login');
    }

    // ===== Login simples =====
    app.get(['/', '/login'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

    app.post('/login', (req, res) => {
        const { password } = req.body;
        const want = '8065537Ncfp@';
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

            // ✅ aplica ao vivo (sem restart)
            if (lead && typeof lead.updateConfig === 'function') {
                lead.updateConfig({
                    inboundDebounceMinMs: global.botSettings.inbound_debounce_min_ms,
                    inboundDebounceMaxMs: global.botSettings.inbound_debounce_max_ms,
                    inboundMaxWaitMs: global.botSettings.inbound_max_wait_ms,
                });
            }

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
                            const stLead = lead.getLead(wa_id);
                            if (stLead && inboundPhoneNumberId) stLead.meta_phone_number_id = inboundPhoneNumberId;
                            if (inboundPhoneNumberId) rememberInboundMetaPhoneNumberId(wa_id, inboundPhoneNumberId);
                        } catch { }

                        let text = '';
                        if (type === 'text') text = m.text?.body || '';
                        else text = `[${type || 'msg'}]`;

                        // ✅ ÚNICO LOG que fica
                        console.log(`[${wa_id}] ${text}`);

                        // memória + SSE inbound
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

                        // batching: enfileira e agrupa por lead
                        if (type === 'text') {
                            lead.enqueueInboundText({
                                wa_id,
                                inboundPhoneNumberId,
                                text,
                                wamid,
                            });
                        }
                    }
                }
            }
        } catch {
            // sem logs
        }
    });

    // ===== ponte: quando o lead “flushar”, o lead.js chama index->onFlushBlock,
    // mas a IA precisa receber o lead “injetado”.
    // Então a gente monkey-patch aqui de um jeito simples:
    const originalOnFlush = app.locals.__onFlushProxy;
    // (não usado — só pra deixar claro que routes não cria timers/flush)

    // IMPORTANTE:
    // O createLeadStore chama onFlushBlock(payload).
    // No index.js a gente passou: onFlushBlock: (payload) => ai.handleInboundBlock(payload)
    // Só que a IA real está em ai._handleInboundBlock e precisa do lead.
    // Então o index deve passar onFlushBlock assim:
    // onFlushBlock: (payload) => ai._handleInboundBlock({ ...payload, lead })
}

module.exports = { registerRoutes };

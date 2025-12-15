function createLeadStore({
    maxMsgs = 50,
    ttlMs = 7 * 24 * 60 * 60 * 1000,

    inboundDebounceMinMs = 1800,
    inboundDebounceMaxMs = 3200,
    inboundMaxWaitMs = 12000,

    onFlushBlock,
} = {}) {
    const leadStore = new Map();

    // ✅ config mutável (pra atualizar pelo painel sem restart)
    const cfg = {
        inboundDebounceMinMs,
        inboundDebounceMaxMs,
        inboundMaxWaitMs,
    };

    function now() { return Date.now(); }

    function normMs(v, def, min, max) {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        let x = Math.trunc(n);
        if (Number.isFinite(min)) x = Math.max(min, x);
        if (Number.isFinite(max)) x = Math.min(max, x);
        return x;
    }

    function updateConfig(next = {}) {
        const nextMin = normMs(next.inboundDebounceMinMs, cfg.inboundDebounceMinMs, 200, 15000);
        const nextMax = normMs(next.inboundDebounceMaxMs, cfg.inboundDebounceMaxMs, 200, 20000);
        const nextWait = normMs(next.inboundMaxWaitMs, cfg.inboundMaxWaitMs, 500, 60000);

        cfg.inboundDebounceMinMs = Math.min(nextMin, nextMax);
        cfg.inboundDebounceMaxMs = Math.max(nextMin, nextMax);
        cfg.inboundMaxWaitMs = nextWait;

        aiLog(`[DEBOUNCE][UPDATE_CONFIG] Updated debounce config - Min: ${cfg.inboundDebounceMinMs}, Max: ${cfg.inboundDebounceMaxMs}, MaxWait: ${cfg.inboundMaxWaitMs}`);
    }

    function randInt(min, max) {
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        return Math.floor(lo + Math.random() * (hi - lo + 1));
    }

    function computeDebounceMs() {
        const debounceTime = randInt(cfg.inboundDebounceMinMs, cfg.inboundDebounceMaxMs);
        aiLog(`[DEBOUNCE][COMPUTE] Debounce time calculated: ${debounceTime}ms`);
        return debounceTime;
    }

    function getLead(wa_id) {
        const key = String(wa_id || '').trim();
        if (!key) return null;

        let st = leadStore.get(key);
        if (!st) {
            st = {
                wa_id: key,
                history: [],
                expiresAt: now() + ttlMs,
                meta_phone_number_id: null,
                last_user_ts: null,
                created_at: now(),

                pending_inbound: [],
                pending_first_ts: null,
                pending_timer: null,
                pending_max_timer: null,
                processing: false,
                flushRequested: false,
            };
            leadStore.set(key, st);
        }

        st.expiresAt = now() + ttlMs;
        return st;
    }

    function clearLeadTimers(st) {
        if (!st) return;
        if (st.pending_timer) {
            clearTimeout(st.pending_timer);
            st.pending_timer = null;
        }
        if (st.pending_max_timer) {
            clearTimeout(st.pending_max_timer);
            st.pending_max_timer = null;
        }
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

        if (st.history.length > maxMsgs) {
            st.history.splice(0, st.history.length - maxMsgs);
        }
    }

    function buildHistoryString(st, opts = {}) {
        const hist = Array.isArray(st?.history) ? st.history : [];
        const excludeWamids = opts.excludeWamids;

        return hist
            .slice(-maxMsgs)
            .filter((m) => {
                if (!excludeWamids || !(excludeWamids instanceof Set)) return true;
                if (m?.role === 'user' && m?.wamid && excludeWamids.has(m.wamid)) return false;
                return true;
            })
            .map((m) => {
                const who = m.role === 'assistant' ? 'ASSISTANT' : (m.role === 'user' ? 'USER' : 'SYSTEM');
                const t = String(m.text || '').replace(/\s+/g, ' ').trim();
                return `${who}: ${t}`;
            })
            .join('\n');
    }

    async function flushLead(wa_id) {
        const st = getLead(wa_id);
        if (!st) return;

        if (st.processing) {
            st.flushRequested = true;
            aiLog(`[DEBOUNCE][FLUSH] wa_id: ${wa_id} is already processing, flush requested.`);
            return;
        }

        if (!st.pending_inbound || st.pending_inbound.length === 0) {
            clearLeadTimers(st);
            st.pending_first_ts = null;
            aiLog(`[DEBOUNCE][FLUSH] wa_id: ${wa_id} no messages to flush.`);
            return;
        }

        const batch = st.pending_inbound.splice(0, st.pending_inbound.length);
        clearLeadTimers(st);
        st.pending_first_ts = null;

        const mergedText = batch.map(b => b.text).join('\n').trim();
        aiLog(`[DEBOUNCE][FLUSH] wa_id: ${wa_id}, messages: ${batch.length}, mergedText: "${mergedText.substring(0, 100)}... (total ${mergedText.length} chars)"`);

        // Log para saber quando o agrupamento de mensagens ocorre
        const lastMsg = batch[batch.length - 1] || null;
        const mensagemAtualBloco = String(lastMsg?.text || '').trim();
        aiLog(`[DEBOUNCE][FLUSH] wa_id: ${wa_id}, mensagemAtualBloco: "${mensagemAtualBloco.substring(0, 100)}... (total ${mensagemAtualBloco.length} chars)"`);

        const excludeWamids = new Set(batch.map(b => b.wamid).filter(Boolean));

        const lastInboundPhoneNumberId =
            batch.map(b => b.inboundPhoneNumberId).filter(Boolean).slice(-1)[0] ||
            st.meta_phone_number_id ||
            null;

        st.processing = true;
        st.flushRequested = false;

        try {
            if (typeof onFlushBlock === 'function') {
                aiLog(`[DEBOUNCE][FLUSH] wa_id: ${wa_id} calling onFlushBlock`);
                await onFlushBlock({
                    wa_id,
                    inboundPhoneNumberId: lastInboundPhoneNumberId,
                    blocoText: mergedText,
                    mensagemAtualBloco,
                    excludeWamids,
                });
            }
        } finally {
            st.processing = false;
        }
    }

    function enqueueInboundText({ wa_id, inboundPhoneNumberId, text, wamid }) {
        const st = getLead(wa_id);
        if (!st) return;

        const cleanText = String(text || '').trim();
        if (!cleanText) return;

        st.pending_inbound.push({
            text: cleanText,
            wamid: wamid || '',
            inboundPhoneNumberId: inboundPhoneNumberId || null,
            ts: now(),
        });

        // Log para entender quando a mensagem foi enfileirada
        aiLog(`[DEBOUNCE][ENQUEUE] wa_id: ${wa_id}, text: "${cleanText}", debounceMin: ${cfg.inboundDebounceMinMs}, debounceMax: ${cfg.inboundDebounceMaxMs}`);

        if (!st.pending_first_ts) {
            st.pending_first_ts = now();

            clearTimeout(st.pending_max_timer);
            st.pending_max_timer = setTimeout(() => {
                flushLead(wa_id).catch(() => { });
            }, cfg.inboundMaxWaitMs);
        }

        // Log quando resetamos o debounce (clearTimeout)
        aiLog(`[DEBOUNCE][CLEAR_TIMEOUT] wa_id: ${wa_id}, resetting debounce timer for ${computeDebounceMs()}ms`);

        clearTimeout(st.pending_timer);
        st.pending_timer = setTimeout(() => {
            flushLead(wa_id).catch(() => { });
        }, computeDebounceMs());
    }

    setInterval(() => {
        const t = now();
        for (const [k, v] of leadStore.entries()) {
            if (!v?.expiresAt || v.expiresAt <= t) {
                try { clearLeadTimers(v); } catch { }
                leadStore.delete(k);
            }
        }
    }, 60 * 60 * 1000);

    return {
        getLead,
        pushHistory,
        buildHistoryString,
        enqueueInboundText,
        updateConfig, // ✅ novo
    };
}

module.exports = { createLeadStore };

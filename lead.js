function createLeadStore({
  maxMsgs = 50,
  ttlMs = 7 * 24 * 60 * 60 * 1000,

  inboundDebounceMinMs = 1800,
  inboundDebounceMaxMs = 3200,
  inboundMaxWaitMs = 12000,

  onFlushBlock,

  // ✅ logs do debounce
  debugDebounce = false,
  debugLog,
} = {}) {
  const leadStore = new Map();

  // ✅ logger seguro
  const _logFn = typeof debugLog === 'function' ? debugLog : console.log;
  function dlog(event, obj) {
    if (!debugDebounce) return;
    try {
      const ts = new Date().toISOString();
      _logFn(`[DEBOUNCE][${event}] ${ts} ${obj ? JSON.stringify(obj) : ''}`);
    } catch {
      // nunca quebra o bot por causa de log
    }
  }

  function previewText(s, max = 80) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + `... (len=${t.length})`;
  }

  const cfg = {
    inboundDebounceMinMs,
    inboundDebounceMaxMs,
    inboundMaxWaitMs,
  };

  function now() { return Date.now(); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    dlog('CONFIG_UPDATE', {
      inboundDebounceMinMs: cfg.inboundDebounceMinMs,
      inboundDebounceMaxMs: cfg.inboundDebounceMaxMs,
      inboundMaxWaitMs: cfg.inboundMaxWaitMs,
    });
  }

  function randInt(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }

  function computeDebounceMs() {
    return randInt(cfg.inboundDebounceMinMs, cfg.inboundDebounceMaxMs);
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

        // ✅ identifica burst
        pending_burst_id: 0,

        // ✅ IMPLEMENTAÇÃO 2: guard de flushing (evita flush concorrente no "late join window")
        flushing: false,
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

  // ✅ IMPLEMENTAÇÃO 1: salvar ts_ms em cada item do histórico
  function pushHistory(wa_id, role, text, extra = {}) {
    const st = getLead(wa_id);
    if (!st) return;

    const tsMs = Number.isFinite(extra.ts_ms) ? extra.ts_ms : now();

    st.history.push({
      role,
      text: String(text || ''),
      ts: new Date(tsMs).toISOString(),
      ts_ms: tsMs,
      ...extra,
    });

    if (role === 'user') st.last_user_ts = now();

    if (st.history.length > maxMsgs) {
      st.history.splice(0, st.history.length - maxMsgs);
    }
  }

  // ✅ IMPLEMENTAÇÃO 1: buildHistoryString com cutoff por maxTsMs
  function buildHistoryString(st, opts = {}) {
    const hist = Array.isArray(st?.history) ? st.history : [];
    const excludeWamids = opts.excludeWamids;
    const maxTsMs = opts.maxTsMs;

    return hist
      .slice(-maxMsgs)
      .filter((m) => {
        // corta tudo que foi gravado depois do cutoff (evita "histórico adiantado")
        if (Number.isFinite(maxTsMs) && Number.isFinite(m?.ts_ms) && m.ts_ms > maxTsMs) return false;

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

  // ✅ flush com "reason" (debounce | maxWait | manual)
  async function flushLead(wa_id, meta = {}) {
    const st = getLead(wa_id);
    if (!st) return;

    const reason = meta?.reason || 'manual';
    const burstId = meta?.burstId || st.pending_burst_id || 0;
    const t0 = now();

    // se já está processando a IA, marca que precisa flushar depois
    if (st.processing) {
      st.flushRequested = true;
      dlog('FLUSH_SKIPPED_PROCESSING', {
        wa_id,
        reason,
        burstId,
        pendingLen: st.pending_inbound?.length || 0,
      });
      return;
    }

    // ✅ IMPLEMENTAÇÃO 2: se já está em flushing (late join / montagem), não concorre
    if (st.flushing) {
      st.flushRequested = true;
      dlog('FLUSH_SKIPPED_FLUSHING', {
        wa_id,
        reason,
        burstId,
        pendingLen: st.pending_inbound?.length || 0,
      });
      return;
    }

    st.flushing = true;
    try {
      if (!st.pending_inbound || st.pending_inbound.length === 0) {
        clearLeadTimers(st);
        st.pending_first_ts = null;
        dlog('FLUSH_EMPTY', { wa_id, reason, burstId });
        return;
      }

      const pendingLenBefore = st.pending_inbound.length;
      const firstTs = st.pending_first_ts || null;
      const lastItemBefore = st.pending_inbound[pendingLenBefore - 1] || null;
      const lastTsBefore = lastItemBefore?.ts || null;

      dlog('FLUSH_BEGIN', {
        wa_id,
        reason,
        burstId,
        pendingLenBefore,
        sinceFirstMs: firstTs ? (t0 - firstTs) : null,
        sinceLastMs: lastTsBefore ? (t0 - lastTsBefore) : null,
        lastPreview: lastItemBefore ? previewText(lastItemBefore.text) : null,
      });

      // ✅ IMPLEMENTAÇÃO 2: "late join window" (pega msg que chegou no limite do flush)
      // Ajuda MUITO no corte tipo: msg chegou 100~300ms depois do flush começar.
      // Mantém curtinho pra não "travar" o bot.
      if (reason === 'debounce' || reason === 'maxWait') {
        await sleep(350);
      }

      // se durante o late-join tudo foi drenado por algum motivo, sai
      if (!st.pending_inbound || st.pending_inbound.length === 0) {
        clearLeadTimers(st);
        st.pending_first_ts = null;
        dlog('FLUSH_EMPTY_AFTER_LATEJOIN', { wa_id, reason, burstId });
        return;
      }

      const batch = st.pending_inbound.splice(0, st.pending_inbound.length);

      // encerra burst atual
      clearLeadTimers(st);
      st.pending_first_ts = null;

      const mergedText = batch.map(b => b.text).join('\n').trim();
      if (!mergedText) {
        dlog('FLUSH_ABORT_EMPTY_MERGED', { wa_id, reason, burstId, batchCount: batch.length });
        return;
      }

      const lastMsg = batch[batch.length - 1] || null;
      const mensagemAtualBloco = String(lastMsg?.text || '').trim();

      const excludeWamids = new Set(batch.map(b => b.wamid).filter(Boolean));

      const lastInboundPhoneNumberId =
        batch.map(b => b.inboundPhoneNumberId).filter(Boolean).slice(-1)[0] ||
        st.meta_phone_number_id ||
        null;

      // ✅ IMPLEMENTAÇÃO 1: cutoff do histórico baseado no TS do último item do batch
      const historyMaxTsMs = Number.isFinite(lastMsg?.ts) ? lastMsg.ts : t0;

      // snapshot congelado do histórico (sem msgs que chegaram depois do batch)
      const historicoStrSnapshot = buildHistoryString(st, {
        excludeWamids,
        maxTsMs: historyMaxTsMs,
      });

      dlog('FLUSH_BATCH_READY', {
        wa_id,
        reason,
        burstId,
        batchCount: batch.length,
        mergedLen: mergedText.length,
        mensagemAtualBlocoPreview: previewText(mensagemAtualBloco),
        excludeWamidsCount: excludeWamids.size,
        inboundPhoneNumberId: lastInboundPhoneNumberId,
        historyMaxTsMs,
      });

      st.processing = true;
      st.flushRequested = false;

      try {
        if (typeof onFlushBlock === 'function') {
          await onFlushBlock({
            wa_id,
            inboundPhoneNumberId: lastInboundPhoneNumberId,
            blocoText: mergedText,
            mensagemAtualBloco,
            excludeWamids,

            // ✅ IMPLEMENTAÇÃO 1: passa o snapshot pro ai.js
            historicoStrSnapshot,
            historyMaxTsMs,

            // debug opcional
            __debounce_debug: {
              reason,
              burstId,
              firstTs,
              lastTsBefore,
              flushAt: t0,
              pendingLenBefore,
              batchCount: batch.length,
              historyMaxTsMs,
            },
          });
        }
      } finally {
        st.processing = false;
        dlog('FLUSH_END', {
          wa_id,
          reason,
          burstId,
          tookMs: now() - t0,
          pendingLenAfter: st.pending_inbound?.length || 0,
          flushRequested: !!st.flushRequested,
        });
      }

      // se chegaram msgs enquanto processava, reagenda
      if ((st.pending_inbound && st.pending_inbound.length > 0) || st.flushRequested) {
        st.flushRequested = false;

        if (!st.pending_first_ts && st.pending_inbound.length > 0) {
          st.pending_first_ts = now();
          // novo burst id para esse “resto”
          st.pending_burst_id = (st.pending_burst_id || 0) + 1;

          const maxWaitMs = cfg.inboundMaxWaitMs;
          clearTimeout(st.pending_max_timer);
          st.pending_max_timer = setTimeout(() => {
            flushLead(wa_id, { reason: 'maxWait', burstId: st.pending_burst_id }).catch(() => { });
          }, maxWaitMs);

          dlog('MAXWAIT_SCHEDULED_AFTER_FLUSH', {
            wa_id,
            burstId: st.pending_burst_id,
            inMs: maxWaitMs,
          });
        }

        const debounceMs = computeDebounceMs();
        clearTimeout(st.pending_timer);
        st.pending_timer = setTimeout(() => {
          flushLead(wa_id, { reason: 'debounce', burstId: st.pending_burst_id }).catch(() => { });
        }, debounceMs);

        dlog('DEBOUNCE_RESCHEDULED_AFTER_FLUSH', {
          wa_id,
          burstId: st.pending_burst_id,
          inMs: debounceMs,
          pendingLen: st.pending_inbound.length,
        });
      }
    } finally {
      st.flushing = false;
    }
  }

  function enqueueInboundText({ wa_id, inboundPhoneNumberId, text, wamid }) {
    const st = getLead(wa_id);
    if (!st) return;

    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const t = now();

    st.pending_inbound.push({
      text: cleanText,
      wamid: wamid || '',
      inboundPhoneNumberId: inboundPhoneNumberId || null,
      ts: t,
    });

    // inicia burst se necessário
    let startedBurst = false;
    if (!st.pending_first_ts) {
      startedBurst = true;
      st.pending_first_ts = t;
      st.pending_burst_id = (st.pending_burst_id || 0) + 1;

      const maxWaitMs = cfg.inboundMaxWaitMs;

      clearTimeout(st.pending_max_timer);
      st.pending_max_timer = setTimeout(() => {
        flushLead(wa_id, { reason: 'maxWait', burstId: st.pending_burst_id }).catch(() => { });
      }, maxWaitMs);

      dlog('MAXWAIT_SCHEDULED', {
        wa_id,
        burstId: st.pending_burst_id,
        inMs: maxWaitMs,
      });
    }

    // agenda debounce (sempre)
    const debounceMs = computeDebounceMs();
    clearTimeout(st.pending_timer);
    st.pending_timer = setTimeout(() => {
      flushLead(wa_id, { reason: 'debounce', burstId: st.pending_burst_id }).catch(() => { });
    }, debounceMs);

    dlog('ENQUEUE', {
      wa_id,
      burstId: st.pending_burst_id,
      startedBurst,
      processing: !!st.processing,
      flushing: !!st.flushing,
      pendingLen: st.pending_inbound.length,
      sinceFirstMs: st.pending_first_ts ? (t - st.pending_first_ts) : null,
      debounceInMs: debounceMs,
      textPreview: previewText(cleanText),
      wamid: wamid || '',
      inboundPhoneNumberId: inboundPhoneNumberId || null,
    });
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
    updateConfig,
    flushLead,
  };
}

module.exports = { createLeadStore };

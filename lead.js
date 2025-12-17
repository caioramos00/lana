function createLeadStore({
  maxMsgs = 50,
  ttlMs = 7 * 24 * 60 * 60 * 1000,

  inboundDebounceMinMs = 1800,
  inboundDebounceMaxMs = 3200,
  inboundMaxWaitMs = 12000,

  lateJoinWindowMs = 350,
  previewTextMaxLen = 80,

  onFlushBlock,

  debugDebounce = false,
  debugLog,
} = {}) {
  const leadStore = new Map();

  const cfg = {
    maxMsgs,
    ttlMs,
    inboundDebounceMinMs,
    inboundDebounceMaxMs,
    inboundMaxWaitMs,
    lateJoinWindowMs,
    previewTextMaxLen,
    debugDebounce,

    inboundDedupeTtlMs: 10 * 60 * 1000, // 10 min
    inboundDedupeMax: 300,             // por lead
  };

  const _logFn = typeof debugLog === 'function' ? debugLog : console.log;
  function dlog(event, obj) {
    if (!cfg.debugDebounce) return;
    try {
      const ts = new Date().toISOString();
      _logFn(`[DEBOUNCE][${event}] ${ts} ${obj ? JSON.stringify(obj) : ''}`);
    } catch { }
  }

  function now() { return Date.now(); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getCooldownState(wa_id) {
    const st = getLead(wa_id);
    if (!st) return null;
    if (!st.cooldown) {
      st.cooldown = { active_until_ts: null, last_started_ts: null, last_reason: null, msgs_since_start: 0 };
    }
    return st.cooldown;
  }

  function isCooldownActive(wa_id) {
    const cd = getCooldownState(wa_id);
    if (!cd) return false;
    const until = Number.isFinite(cd.active_until_ts) ? cd.active_until_ts : null;
    if (!until) return false;
    return now() < until;
  }

  function startCooldown(wa_id, { durationMs = 15 * 60 * 1000, reason = 'offer' } = {}) {
    const cd = getCooldownState(wa_id);
    if (!cd) return;

    const t = now();
    const dur = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;

    cd.last_started_ts = t;
    cd.active_until_ts = t + dur;
    cd.last_reason = reason;
    cd.msgs_since_start = 0;

    dlog('COOLDOWN_START', {
      wa_id,
      reason,
      durationMs: dur,
      until: cd.active_until_ts,
    });
  }

  function stopCooldown(wa_id, { reason = 'manual' } = {}) {
    const cd = getCooldownState(wa_id);
    if (!cd) return;

    cd.active_until_ts = null;
    cd.last_reason = reason;

    dlog('COOLDOWN_STOP', { wa_id, reason });
  }

  function bumpCooldownOnUserMsg(wa_id) {
    const cd = getCooldownState(wa_id);
    if (!cd) return;
    cd.msgs_since_start = (cd.msgs_since_start || 0) + 1;

    dlog('COOLDOWN_BUMP', {
      wa_id,
      msgs_since_start: cd.msgs_since_start,
      active: isCooldownActive(wa_id),
      until: cd.active_until_ts || null,
    });
  }

  function previewText(s, max) {
    const limit = Number.isFinite(Number(max)) ? Number(max) : cfg.previewTextMaxLen;
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= limit) return t;
    return t.slice(0, limit) + `... (len=${t.length})`;
  }

  function toIntOrNull(v) {
    if (v === undefined || v === null) return null;
    const n = Number(String(v).trim());
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  function clampInt(n, { min, max } = {}) {
    if (!Number.isFinite(n)) return null;
    let x = Math.trunc(n);
    if (Number.isFinite(min)) x = Math.max(min, x);
    if (Number.isFinite(max)) x = Math.min(max, x);
    return x;
  }

  function updateConfig(next = {}) {
    const nextMin = clampInt(toIntOrNull(next.inboundDebounceMinMs), { min: 200, max: 15000 });
    const nextMax = clampInt(toIntOrNull(next.inboundDebounceMaxMs), { min: 200, max: 20000 });
    const nextWait = clampInt(toIntOrNull(next.inboundMaxWaitMs), { min: 500, max: 60000 });

    if (Number.isFinite(nextMin)) cfg.inboundDebounceMinMs = nextMin;
    if (Number.isFinite(nextMax)) cfg.inboundDebounceMaxMs = nextMax;
    if (Number.isFinite(nextWait)) cfg.inboundMaxWaitMs = nextWait;

    if (cfg.inboundDebounceMinMs > cfg.inboundDebounceMaxMs) {
      const tmp = cfg.inboundDebounceMinMs;
      cfg.inboundDebounceMinMs = cfg.inboundDebounceMaxMs;
      cfg.inboundDebounceMaxMs = tmp;
    }

    const nextMaxMsgs = clampInt(toIntOrNull(next.maxMsgs), { min: 5, max: 500 });
    if (Number.isFinite(nextMaxMsgs)) {
      cfg.maxMsgs = nextMaxMsgs;
      for (const st of leadStore.values()) {
        if (Array.isArray(st?.history) && st.history.length > cfg.maxMsgs) {
          st.history.splice(0, st.history.length - cfg.maxMsgs);
        }
      }
    }

    const nextTtlMs = clampInt(toIntOrNull(next.ttlMs), { min: 60_000, max: 2_147_000_000 });
    if (Number.isFinite(nextTtlMs)) {
      cfg.ttlMs = nextTtlMs;
      const t = now();
      for (const st of leadStore.values()) {
        st.expiresAt = t + cfg.ttlMs;
      }
    }

    const nextLateJoin = clampInt(toIntOrNull(next.lateJoinWindowMs), { min: 0, max: 5000 });
    if (Number.isFinite(nextLateJoin)) cfg.lateJoinWindowMs = nextLateJoin;

    const nextPrevMax = clampInt(toIntOrNull(next.previewTextMaxLen), { min: 10, max: 500 });
    if (Number.isFinite(nextPrevMax)) cfg.previewTextMaxLen = nextPrevMax;

    if (next.debugDebounce !== undefined && next.debugDebounce !== null) {
      cfg.debugDebounce = !!next.debugDebounce;
    }

    dlog('CONFIG_UPDATE', {
      inboundDebounceMinMs: cfg.inboundDebounceMinMs,
      inboundDebounceMaxMs: cfg.inboundDebounceMaxMs,
      inboundMaxWaitMs: cfg.inboundMaxWaitMs,
      maxMsgs: cfg.maxMsgs,
      ttlMs: cfg.ttlMs,
      lateJoinWindowMs: cfg.lateJoinWindowMs,
      previewTextMaxLen: cfg.previewTextMaxLen,
      debugDebounce: cfg.debugDebounce,
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
        expiresAt: now() + cfg.ttlMs,
        meta_phone_number_id: null,
        last_user_ts: null,
        created_at: now(),

        pending_inbound: [],
        pending_first_ts: null,
        pending_timer: null,
        pending_max_timer: null,
        processing: false,
        flushRequested: false,

        pending_burst_id: 0,
        flushing: false,
        cooldown: {
          active_until_ts: null,
          last_started_ts: null,
          last_reason: null,
          msgs_since_start: 0,
        },

        // ✅ inbound dedupe
        __seen_in_wamids: new Map(), // wamid -> ts_ms
      };
      leadStore.set(key, st);
    }

    st.expiresAt = now() + cfg.ttlMs;
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

  // ✅ DEDUPE helpers
  function _cleanupSeenInbound(st) {
    const m = st?.__seen_in_wamids;
    if (!(m instanceof Map)) return;

    const t = now();
    for (const [k, v] of m.entries()) {
      if (!v || (t - v) > cfg.inboundDedupeTtlMs) m.delete(k);
    }

    // limita tamanho
    const max = cfg.inboundDedupeMax;
    if (m.size > max) {
      const arr = Array.from(m.entries()).sort((a, b) => (a[1] || 0) - (b[1] || 0));
      const drop = m.size - max;
      for (let i = 0; i < drop; i++) m.delete(arr[i][0]);
    }
  }

  function markInboundWamidSeen(wa_id, wamid) {
    const st = getLead(wa_id);
    if (!st) return { ok: false, duplicate: false };

    const w = String(wamid || '').trim();
    if (!w) return { ok: false, duplicate: false };

    if (!(st.__seen_in_wamids instanceof Map)) st.__seen_in_wamids = new Map();
    _cleanupSeenInbound(st);

    if (st.__seen_in_wamids.has(w)) {
      return { ok: true, duplicate: true };
    }

    st.__seen_in_wamids.set(w, now());
    return { ok: true, duplicate: false };
  }

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

    if (st.history.length > cfg.maxMsgs) {
      st.history.splice(0, st.history.length - cfg.maxMsgs);
    }
  }

  function buildHistoryString(st, opts = {}) {
    const hist = Array.isArray(st?.history) ? st.history : [];
    const excludeWamids = opts.excludeWamids;
    const maxTsMs = opts.maxTsMs;

    return hist
      .slice(-cfg.maxMsgs)
      .filter((m) => {
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

  async function flushLead(wa_id, meta = {}) {
    const st = getLead(wa_id);
    if (!st) return;

    const reason = meta?.reason || 'manual';
    const burstId = meta?.burstId || st.pending_burst_id || 0;
    const t0 = now();

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

      if (reason === 'debounce' || reason === 'maxWait') {
        const w = Number.isFinite(cfg.lateJoinWindowMs) ? cfg.lateJoinWindowMs : 350;
        if (w > 0) await sleep(w);
      }

      if (!st.pending_inbound || st.pending_inbound.length === 0) {
        clearLeadTimers(st);
        st.pending_first_ts = null;
        dlog('FLUSH_EMPTY_AFTER_LATEJOIN', { wa_id, reason, burstId });
        return;
      }

      const batch = st.pending_inbound.splice(0, st.pending_inbound.length);

      const batch_items = batch
        .map((b) => ({
          wamid: String(b?.wamid || '').trim(),
          text: String(b?.text || '').trim(),
          ts_ms: Number.isFinite(b?.ts) ? b.ts : null,
        }))
        .filter((x) => x.wamid && x.text);

      clearLeadTimers(st);
      st.pending_first_ts = null;

      const mergedText = batch.map(b => b.text).join('\n').trim();
      if (!mergedText) {
        dlog('FLUSH_ABORT_EMPTY_MERGED', { wa_id, reason, burstId, batchCount: batch.length });
        return;
      }

      const lastMsg = batch[batch.length - 1] || null;
      const replyToWamid = String(lastMsg?.wamid || '').trim();
      const mensagemAtualBloco = String(lastMsg?.text || '').trim();

      const excludeWamids = new Set(batch.map(b => b.wamid).filter(Boolean));

      const lastInboundPhoneNumberId =
        batch.map(b => b.inboundPhoneNumberId).filter(Boolean).slice(-1)[0] ||
        st.meta_phone_number_id ||
        null;

      const historyMaxTsMs = Number.isFinite(lastMsg?.ts) ? lastMsg.ts : t0;

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
            replyToWamid,
            batch_items,
            historicoStrSnapshot,
            historyMaxTsMs,
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

      if ((st.pending_inbound && st.pending_inbound.length > 0) || st.flushRequested) {
        st.flushRequested = false;

        if (!st.pending_first_ts && st.pending_inbound.length > 0) {
          st.pending_first_ts = now();
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
    bumpCooldownOnUserMsg(wa_id);

    st.pending_inbound.push({
      text: cleanText,
      wamid: wamid || '',
      inboundPhoneNumberId: inboundPhoneNumberId || null,
      ts: t,
    });

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
    getCooldownState,
    isCooldownActive,
    startCooldown,
    stopCooldown,
    bumpCooldownOnUserMsg,

    // ✅ exporta se quiser logar/usar no routes.js
    markInboundWamidSeen,
  };
}

module.exports = { createLeadStore };

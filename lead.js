const { createDebounceEngine } = require('./debounce');

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
    inboundDedupeTtlMs: 10 * 60 * 1000,
    inboundDedupeMax: 300,
  };

  const _logFn = typeof debugLog === 'function' ? debugLog : console.log;

  function dlog(event, obj) {
    if (!cfg.debugDebounce) return;
    try {
      const ts = new Date().toISOString();
      _logFn(`[DEBOUNCE][${event}] ${ts} ${obj ? JSON.stringify(obj) : ''}`);
    } catch { }
  }

  function now() {
    return Date.now();
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

  function ensureAudioState(st) {
    if (!st) return null;

    if (!st.audio_policy || typeof st.audio_policy !== 'object') {
      st.audio_policy = {
        text_streak_count: 0,
        last_audio_ts: null,
        last_audio_kind: null,
      };
    }

    if (!Number.isFinite(st.audio_policy.text_streak_count)) st.audio_policy.text_streak_count = 0;

    return st.audio_policy;
  }

  function ensurePaymentsState(st) {
    if (!st) return null;

    if (!st.payments_state || typeof st.payments_state !== 'object') {
      st.payments_state = { pending: null, last_paid: null, vip_link_sent: false };
    }

    if (st.ja_comprou_vip === undefined || st.ja_comprou_vip === null) st.ja_comprou_vip = false;

    return st.payments_state;
  }

  function isVipOffer(offer_id) {
    const id = String(offer_id || '').toLowerCase();
    return (
      /\bvip\b/.test(id) ||
      id.includes('assin') ||
      id.includes('plano') ||
      id.includes('vital') ||
      id.includes('grupo_whats')
    );
  }

  function getLead(wa_id) {
    const key = String(wa_id || '').trim();
    if (!key) return null;

    let st = leadStore.get(key);
    if (!st) {
      const t = now();
      st = {
        wa_id: key,
        history: [],
        expiresAt: t + cfg.ttlMs,
        meta_phone_number_id: null,
        last_user_ts: null,
        created_at: t,

        first_inbound_payload: null,
        first_inbound_captured_ts: null,

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

        audio_policy: {
          text_streak_count: 0,
          last_audio_ts: null,
          last_audio_kind: null,
        },

        __seen_in_wamids: new Map(),

        ja_comprou_vip: false,
        payments_state: {
          pending: null,
          last_paid: null,
          vip_link_sent: false,
        },
      };
      leadStore.set(key, st);
    }

    st.expiresAt = now() + cfg.ttlMs;
    return st;
  }

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

    if (role === 'assistant') {
      const a = ensureAudioState(st);
      const kind = String(extra?.kind || 'text').trim().toLowerCase();

      if (kind === 'text') {
        a.text_streak_count = (a.text_streak_count || 0) + 1;
      } else {
        a.text_streak_count = 0;
        a.last_audio_ts = tsMs;
        a.last_audio_kind = String(extra?.audio_kind || kind || '').trim() || null;
      }
    }

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
        let t = String(m.text || '').replace(/\s+/g, ' ').trim();

        const audioTxt = String(m.audio_text || '').replace(/\s+/g, ' ').trim();
        if (audioTxt) {
          t = t ? `${t} ${audioTxt}` : audioTxt;
        }

        return `${who}: ${t}`;
      })
      .join('\n');
  }

  function getAudioState(wa_id) {
    const st = getLead(wa_id);
    if (!st) return null;
    return ensureAudioState(st);
  }

  function markPixCreated(wa_id, info = {}) {
    const st = getLead(wa_id);
    if (!st) return { ok: false };

    const ps = ensurePaymentsState(st);

    ps.pending = {
      provider: info.provider || null,
      external_id: info.external_id || null,
      transaction_id: info.transaction_id || null,
      status: info.status || 'PENDING',
      offer_id: info.offer_id || null,
      amount: Number(info.amount || 0) || 0,
      created_ts_ms: Number(info.created_ts_ms || Date.now()),
    };

    return { ok: true };
  }

  function markPaymentCompleted(wa_id, info = {}) {
    const st = getLead(wa_id);
    if (!st) return { ok: false };

    const ps = ensurePaymentsState(st);

    ps.last_paid = {
      provider: info.provider || null,
      external_id: info.external_id || null,
      transaction_id: info.transaction_id || null,
      status: info.status || 'PAID',
      offer_id: info.offer_id || null,
      amount: Number(info.amount || 0) || 0,
      paid_ts_ms: Number(info.paid_ts_ms || Date.now()),
      end_to_end: info.end_to_end || null,
    };

    ps.pending = null;

    if (isVipOffer(info.offer_id)) {
      st.ja_comprou_vip = true;
    }

    return { ok: true };
  }

  function markVipLinkSent(wa_id) {
    const st = getLead(wa_id);
    if (!st) return { ok: false };
    const ps = ensurePaymentsState(st);
    ps.vip_link_sent = true;
    return { ok: true };
  }

  const debounce = createDebounceEngine({
    cfg,
    leadStore,
    getLead,
    buildHistoryString,
    onFlushBlock,
    dlog,
    now,
    bumpCooldownOnUserMsg,
  });

  setInterval(() => {
    const t = now();
    for (const [k, v] of leadStore.entries()) {
      if (!v?.expiresAt || v.expiresAt <= t) {
        try { debounce.clearLeadTimers(v); } catch { }
        leadStore.delete(k);
      }
    }
  }, 60 * 60 * 1000);

  return {
    getLead,
    pushHistory,
    buildHistoryString,
    enqueueInboundText: debounce.enqueueInboundText,
    updateConfig,
    flushLead: debounce.flushLead,
    getCooldownState,
    isCooldownActive,
    startCooldown,
    stopCooldown,
    bumpCooldownOnUserMsg,
    getAudioState,
    markInboundWamidSeen: debounce.markInboundWamidSeen,
    markPixCreated,
    markPaymentCompleted,
    markVipLinkSent,
  };
}

module.exports = { createLeadStore };

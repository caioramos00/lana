function createDebounceEngine({
  cfg,
  leadStore,
  getLead,
  buildHistoryString,
  onFlushBlock,
  dlog,
  now,
  bumpCooldownOnUserMsg,
}) {
  const _now = typeof now === 'function' ? now : () => Date.now();
  const _dlog = typeof dlog === 'function' ? dlog : () => { };

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function randInt(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }

  function previewText(s, max) {
    const limit = Number.isFinite(Number(max)) ? Number(max) : cfg.previewTextMaxLen;
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= limit) return t;
    return t.slice(0, limit) + `... (len=${t.length})`;
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

  function computeDebounceMs(st) {
    const minRaw = Number(cfg.inboundDebounceMinMs);
    const maxRaw = Number(cfg.inboundDebounceMaxMs);

    const min = Number.isFinite(minRaw) ? minRaw : 1800;
    const max = Number.isFinite(maxRaw) ? maxRaw : 3200;

    const lo = Math.min(min, max);
    const hi = Math.max(min, max);

    let ms = randInt(lo, hi);

    const maxWaitRaw = Number(cfg.inboundMaxWaitMs);
    const maxWait = Number.isFinite(maxWaitRaw) ? maxWaitRaw : 12000;

    if (st && Number.isFinite(st.pending_first_ts) && maxWait > 0) {
      const elapsed = _now() - st.pending_first_ts;
      const remaining = maxWait - elapsed;
      if (Number.isFinite(remaining) && remaining > 50) {
        ms = Math.min(ms, remaining);
      }
    }

    if (!Number.isFinite(ms) || ms < 0) ms = lo;
    return ms;
  }

  function cleanupSeenInbound(st) {
    const m = st?.__seen_in_wamids;
    if (!(m instanceof Map)) return;

    const t = _now();
    for (const [k, v] of m.entries()) {
      if (!v || (t - v) > cfg.inboundDedupeTtlMs) m.delete(k);
    }

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
    cleanupSeenInbound(st);

    if (st.__seen_in_wamids.has(w)) {
      return { ok: true, duplicate: true };
    }

    st.__seen_in_wamids.set(w, _now());
    return { ok: true, duplicate: false };
  }

  async function flushLead(wa_id, meta = {}) {
    const st = getLead(wa_id);
    if (!st) return;

    const reason = meta?.reason || 'manual';
    const burstId = meta?.burstId || st.pending_burst_id || 0;
    const t0 = _now();

    if (st.processing) {
      st.flushRequested = true;
      _dlog('FLUSH_SKIPPED_PROCESSING', {
        wa_id,
        reason,
        burstId,
        pendingLen: st.pending_inbound?.length || 0,
      });
      return;
    }

    if (st.flushing) {
      st.flushRequested = true;
      _dlog('FLUSH_SKIPPED_FLUSHING', {
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
        _dlog('FLUSH_EMPTY', { wa_id, reason, burstId });
        return;
      }

      const pendingLenBefore = st.pending_inbound.length;
      const firstTs = st.pending_first_ts || null;
      const lastItemBefore = st.pending_inbound[pendingLenBefore - 1] || null;
      const lastTsBefore = lastItemBefore?.ts || null;

      _dlog('FLUSH_BEGIN', {
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
        _dlog('FLUSH_EMPTY_AFTER_LATEJOIN', { wa_id, reason, burstId });
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
        _dlog('FLUSH_ABORT_EMPTY_MERGED', { wa_id, reason, burstId, batchCount: batch.length });
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

      _dlog('FLUSH_BATCH_READY', {
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
        _dlog('FLUSH_END', {
          wa_id,
          reason,
          burstId,
          tookMs: _now() - t0,
          pendingLenAfter: st.pending_inbound?.length || 0,
          flushRequested: !!st.flushRequested,
        });
      }

      if ((st.pending_inbound && st.pending_inbound.length > 0) || st.flushRequested) {
        st.flushRequested = false;

        if (!st.pending_first_ts && st.pending_inbound.length > 0) {
          st.pending_first_ts = _now();
          st.pending_burst_id = (st.pending_burst_id || 0) + 1;

          const maxWaitMs = cfg.inboundMaxWaitMs;
          clearTimeout(st.pending_max_timer);
          st.pending_max_timer = setTimeout(() => {
            flushLead(wa_id, { reason: 'maxWait', burstId: st.pending_burst_id }).catch(() => { });
          }, maxWaitMs);

          _dlog('MAXWAIT_SCHEDULED_AFTER_FLUSH', {
            wa_id,
            burstId: st.pending_burst_id,
            inMs: maxWaitMs,
          });
        }

        const debounceMs = computeDebounceMs(st);
        clearTimeout(st.pending_timer);
        st.pending_timer = setTimeout(() => {
          flushLead(wa_id, { reason: 'debounce', burstId: st.pending_burst_id }).catch(() => { });
        }, debounceMs);

        _dlog('DEBOUNCE_RESCHEDULED_AFTER_FLUSH', {
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

    const t = _now();
    if (typeof bumpCooldownOnUserMsg === 'function') bumpCooldownOnUserMsg(wa_id);

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

      _dlog('MAXWAIT_SCHEDULED', {
        wa_id,
        burstId: st.pending_burst_id,
        inMs: maxWaitMs,
      });
    }

    const debounceMs = computeDebounceMs(st);
    clearTimeout(st.pending_timer);
    st.pending_timer = setTimeout(() => {
      flushLead(wa_id, { reason: 'debounce', burstId: st.pending_burst_id }).catch(() => { });
    }, debounceMs);

    _dlog('ENQUEUE', {
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

  return {
    enqueueInboundText,
    flushLead,
    clearLeadTimers,
    markInboundWamidSeen,
  };
}

module.exports = { createDebounceEngine };

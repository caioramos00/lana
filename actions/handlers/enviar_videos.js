const { CONFIG } = require('../config');

function toItems(payload) {
  const p = payload || {};

  if (typeof p.url === 'string') {
    const u = p.url.trim();
    return u ? [{ url: u, caption: p.caption }] : [];
  }
  if (Array.isArray(p.urls)) {
    return p.urls
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map((u) => ({ url: u, caption: p.caption }));
  }
  if (Array.isArray(p.items)) {
    return p.items
      .map((it) => {
        if (typeof it === 'string') return { url: it };
        return { url: it?.url, caption: it?.caption };
      })
      .map((it) => ({
        url: String(it.url || '').trim(),
        caption: String(it.caption || '').trim(),
      }))
      .filter((it) => !!it.url);
  }
  return [];
}

function fallbackItemsFromConfig() {
  const m = CONFIG?.media || {};
  const cand = m.videos || m.videosUrls || m.videoUrls || null;

  if (typeof cand === 'string') {
    const u = cand.trim();
    return u ? [{ url: u }] : [];
  }
  if (Array.isArray(cand)) {
    return cand
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map((u) => ({ url: u }));
  }
  return [];
}

module.exports = async function enviar_videos(ctx, payload) {
  if (typeof ctx.senders.sendVideo !== 'function') {
    return { ok: false, reason: 'sendVideo-not-implemented' };
  }

  const items = toItems(payload);
  const list = items.length ? items : fallbackItemsFromConfig();
  if (!list.length) {
    return {
      ok: false,
      reason: 'missing-videoUrls',
      hint: 'Defina payload.urls (string[]) ou CONFIG.media.videoUrls (string[])',
    };
  }

  const defaultCaption = String(payload?.caption || '').trim() || 'Segue o vídeo 👇';
  const delayBetweenMs = (payload && Array.isArray(payload.delayBetweenMs)) ? payload.delayBetweenMs : [250, 900];

  const results = [];
  for (let i = 0; i < list.length; i++) {
    const url = String(list[i]?.url || '').trim();
    const caption = String(list[i]?.caption || '').trim() || defaultCaption;

    if (!/^https?:\/\//i.test(url)) {
      results.push({ ok: false, reason: 'invalid-url', url });
      continue;
    }

    const r = await ctx.senders.sendVideo(ctx.wa_id, url, {
      caption,
      meta_phone_number_id: ctx.inboundPhoneNumberId || null,
      ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
    });

    results.push(r);

    if (r?.ok) {
      ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[video]', {
        kind: 'video',
        wamid: r.wamid || '',
        phone_number_id: r.phone_number_id || ctx.inboundPhoneNumberId || null,
        ts_ms: Date.now(),
        reply_to_wamid: ctx.replyToWamid || null,
      });
    }

    if (i < list.length - 1) {
      await ctx.delay(delayBetweenMs[0] || 250, delayBetweenMs[1] || 900);
    }
  }

  const okAll = results.every((x) => x?.ok);
  return { ok: okAll, results };
};

// actions/handlers/enviar_audios.js
// Envia 1+ áudios (URLs públicas) pelo WhatsApp Cloud API.
//
// Observação: WhatsApp Cloud API não suporta caption em áudio.
//
// Fontes de mídia (ordem):
// 1) payload.urls / payload.items
// 2) CONFIG.media.audios / CONFIG.media.audiosUrls / CONFIG.media.audioUrls

const { CONFIG } = require('../config');

function toUrls(payload) {
  const p = payload || {};

  if (typeof p.url === 'string') {
    const u = p.url.trim();
    return u ? [u] : [];
  }
  if (Array.isArray(p.urls)) {
    return p.urls.map(x => String(x || '').trim()).filter(Boolean);
  }
  if (Array.isArray(p.items)) {
    return p.items
      .map((it) => (typeof it === 'string' ? it : it?.url))
      .map((x) => String(x || '').trim())
      .filter(Boolean);
  }
  return [];
}

function fallbackUrlsFromConfig() {
  const m = CONFIG?.media || {};
  const cand = m.audios || m.audiosUrls || m.audioUrls || null;
  if (typeof cand === 'string') {
    const u = cand.trim();
    return u ? [u] : [];
  }
  if (Array.isArray(cand)) {
    return cand.map(x => String(x || '').trim()).filter(Boolean);
  }
  return [];
}

module.exports = async function enviar_audios(ctx, payload) {
  if (typeof ctx.senders.sendAudio !== 'function') {
    return { ok: false, reason: 'sendAudio-not-implemented' };
  }

  const urls = toUrls(payload);
  const list = urls.length ? urls : fallbackUrlsFromConfig();
  if (!list.length) {
    return {
      ok: false,
      reason: 'missing-audioUrls',
      hint: 'Defina payload.urls (string[]) ou CONFIG.media.audioUrls (string[])',
    };
  }

  const delayBetweenMs = (payload && Array.isArray(payload.delayBetweenMs)) ? payload.delayBetweenMs : [250, 900];

  const results = [];
  for (let i = 0; i < list.length; i++) {
    const url = String(list[i] || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      results.push({ ok: false, reason: 'invalid-url', url });
      continue;
    }

    const r = await ctx.senders.sendAudio(ctx.wa_id, url, {
      meta_phone_number_id: ctx.inboundPhoneNumberId || null,
      ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
    });

    results.push(r);

    if (r?.ok) {
      ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[audio]', {
        kind: 'audio',
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

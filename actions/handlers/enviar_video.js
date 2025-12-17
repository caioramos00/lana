const { CONFIG } = require('../config');

module.exports = async function enviar_video(ctx, payload) {
  const p = payload || {};
  const url = String(p.url || (CONFIG?.media?.videoUrl || '')).trim();
  if (!url) return { ok: false, reason: 'missing-videoUrl' };

  if (typeof ctx.senders.sendVideo !== 'function') {
    return { ok: false, reason: 'sendVideo-not-implemented' };
  }

  const caption = String(p.caption || 'Segue o vídeo 👇').trim();

  const r = await ctx.senders.sendVideo(ctx.wa_id, url, {
    caption,
    meta_phone_number_id: ctx.inboundPhoneNumberId || null,
    ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
  });

  if (r?.ok) {
    ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[video]', {
      kind: 'video',
      wamid: r.wamid || '',
      phone_number_id: r.phone_number_id || ctx.inboundPhoneNumberId || null,
      ts_ms: Date.now(),
      reply_to_wamid: ctx.replyToWamid || null,
    });
  }

  return r;
};

'use strict';

module.exports = async function enviar_previa_video(ctx, payload) {
  const preview_id = String(payload?.preview_id || 'previa_video').trim();

  console.log(`[PREVIEW][${ctx.wa_id}] handler enviar_previa_video preview_id=${preview_id}`);

  const r = await ctx.senders.sendPreviewToLead({
    wa_id: ctx.wa_id,
    preview_id,
    inboundPhoneNumberId: ctx.inboundPhoneNumberId,
    db: ctx.db,
  });

  console.log(`[PREVIEW][${ctx.wa_id}] result enviar_previa_video=`, r);
  return r;
};

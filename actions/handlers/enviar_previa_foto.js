'use strict';

module.exports = async function enviar_previa_foto(ctx, payload) {
  const preview_id = String(payload?.preview_id || 'previa_foto').trim();

  console.log(`[PREVIEW][${ctx.wa_id}] handler enviar_previa_foto preview_id=${preview_id}`);

  const r = await ctx.senders.sendPreviewToLead({
    wa_id: ctx.wa_id,
    preview_id,
    inboundPhoneNumberId: ctx.inboundPhoneNumberId,
    db: ctx.db,
  });

  console.log(`[PREVIEW][${ctx.wa_id}] result enviar_previa_foto=`, r);
  return r;
};

module.exports = async function enviar_audio(ctx, payload) {
  const text = (payload && payload.text)
    ? String(payload.text)
    : (typeof payload === 'string' ? String(payload) : '');

  const finalText = String(text || '').trim()
    ? String(text).trim()
    : 'Posso te explicar rapidinho por áudio. É só seguir o passo a passo que dá certo.';

  const r = await ctx.senders.sendTtsVoiceNote(ctx.wa_id, finalText, {
    meta_phone_number_id: ctx.inboundPhoneNumberId || null,
    ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
  });

  if (r?.ok) {
    ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[audio]', {
      kind: 'audio',
      wamid: r.wamid || '',
      phone_number_id: r.phone_number_id || ctx.inboundPhoneNumberId || null,
      ts_ms: Date.now(),
      reply_to_wamid: ctx.replyToWamid || null,
    });
  }

  return r;
};

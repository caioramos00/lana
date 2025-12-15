module.exports = async function enviar_audio(ctx, payload) {
  const text = (payload && payload.text)
    ? String(payload.text)
    : 'Posso te explicar rapidinho por áudio. É só seguir o passo a passo que dá certo.';

  // ✅ se você não passar isso aqui, NUNCA entra no branch do response.opus
  const sendResponseOpus = !!(payload && payload.send_response_opus);

  const r = await ctx.senders.sendTtsVoiceNote(ctx.wa_id, text, {
    meta_phone_number_id: ctx.inboundPhoneNumberId || null,
    ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),

    // ✅ DEBUG toggle
    send_response_opus: sendResponseOpus,
    // (opcional) se quiser apontar um caminho diferente:
    // response_opus_path: payload?.response_opus_path,
  });

  if (r?.ok) {
    ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[audio]', {
      kind: 'audio',
      wamid: r.wamid || '',
      phone_number_id: r.phone_number_id || ctx.inboundPhoneNumberId || null,
      ts_ms: Date.now(),
      reply_to_wamid: ctx.replyToWamid || null,
      sent_from: r.sent_from || null,
    });
  }

  return r;
};

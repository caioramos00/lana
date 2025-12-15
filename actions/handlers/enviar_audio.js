module.exports = async function enviar_audio(ctx, payload) {
  let sendResponseOpus = false;
  let text = '';

  // payload pode vir como string (muito comum em “actions”)
  if (typeof payload === 'string') {
    const p = payload.trim();
    if (p === '__response_opus__' || p === 'response.opus' || p === 'response_opus') {
      sendResponseOpus = true;
      text = 'ok';
    } else {
      text = p;
    }
  } else {
    text = (payload && payload.text) ? String(payload.text) : '';
    sendResponseOpus = !!(payload && (payload.send_response_opus || payload.mode === 'response_opus' || payload.debug === 'response_opus'));

    if (String(text || '').trim() === '__response_opus__') {
      sendResponseOpus = true;
      text = 'ok';
    }
  }

  if (!text) {
    text = 'Posso te explicar rapidinho por áudio. É só seguir o passo a passo que dá certo.';
  }

  console.log('[AUDIO][DEBUG][enviar_audio]', JSON.stringify({
    payloadType: typeof payload,
    sendResponseOpus,
    hasText: !!text,
  }));

  const r = await ctx.senders.sendTtsVoiceNote(ctx.wa_id, text, {
    meta_phone_number_id: ctx.inboundPhoneNumberId || null,
    ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
    send_response_opus: sendResponseOpus,
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

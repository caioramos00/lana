module.exports = {
  key: 'enviar_pix',
  priority: 10,

  async run(ctx) {
    const { wa_id, inboundPhoneNumberId, replyToWamid, payload, senders, lead } = ctx;

    // Você pode puxar isso do DB depois (bot_settings), mas o mais rápido é ENV:
    const pix = (process.env.PIX_CHAVE || '').trim();
    const nome = (process.env.PIX_NOME || '').trim();
    const banco = (process.env.PIX_BANCO || '').trim();

    if (!pix) throw new Error('enviar_pix: faltou PIX_CHAVE no env');

    const valor = payload.valor ? String(payload.valor).trim() : null; // opcional
    const msg =
      `PIX pra pagamento:\n` +
      `Chave: ${pix}` +
      (nome ? `\nNome: ${nome}` : '') +
      (banco ? `\nBanco: ${banco}` : '') +
      (valor ? `\nValor: ${valor}` : '');

    const r = await senders.sendMessage(wa_id, msg, {
      meta_phone_number_id: inboundPhoneNumberId || null,
      ...(replyToWamid ? { reply_to_wamid: replyToWamid } : {}),
    });

    if (r?.ok && lead?.pushHistory) {
      lead.pushHistory(wa_id, 'assistant', msg, {
        kind: 'text',
        wamid: r.wamid || '',
        phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
        ts_ms: Date.now(),
      });
    }

    return r;
  },
};

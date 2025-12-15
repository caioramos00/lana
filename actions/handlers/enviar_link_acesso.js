module.exports = {
  key: 'enviar_link_acesso',
  priority: 20,

  async run(ctx) {
    const { wa_id, inboundPhoneNumberId, replyToWamid, payload, senders, lead } = ctx;

    const link = String(payload.link || process.env.ACESSO_LINK || '').trim();
    if (!link) throw new Error('enviar_link_acesso: faltou payload.link ou ACESSO_LINK');

    const msg = `Aqui está seu acesso:\n${link}`;

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

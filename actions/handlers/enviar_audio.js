module.exports = {
  key: 'enviar_audio',
  priority: 30,

  async run(ctx) {
    const { wa_id, inboundPhoneNumberId, replyToWamid, payload, senders, lead } = ctx;

    // Sugestão: no prompt, permita payload opcional:
    // "enviar_audio": { "mode": "tts", "text": "..." }
    const mode = String(payload.mode || 'tts').toLowerCase();
    const text = String(payload.text || '').trim();

    if (mode !== 'tts') {
      throw new Error(`enviar_audio: mode não suportado: ${mode}`);
    }
    if (!text) {
      // fallback: se você quiser, pode usar a última msg do agente como base
      throw new Error('enviar_audio: faltou payload.text');
    }

    const r = await senders.sendTtsVoiceNote(wa_id, text, {
      meta_phone_number_id: inboundPhoneNumberId || null,
      ...(replyToWamid ? { reply_to_wamid: replyToWamid } : {}),
    });

    // opcional: jogar no histórico do lead, pra IA “lembrar”
    if (r?.ok && lead?.pushHistory) {
      lead.pushHistory(wa_id, 'assistant', '[audio enviado]', {
        kind: 'audio',
        wamid: r.wamid || '',
        phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
        ts_ms: Date.now(),
      });
    }

    return r;
  },
};

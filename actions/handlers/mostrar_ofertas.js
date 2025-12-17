const { CONFIG } = require('../config');

function pickOfferSet(ctx, payload) {
  const setFromPayload = payload && typeof payload === 'object' ? payload.set : null;
  if (setFromPayload && CONFIG.offerSets?.[setFromPayload]) return setFromPayload;

  const intent = String(ctx?.agent?.intent_detectada || '').trim();
  const setFromIntent = CONFIG.intentToOfferSet?.[intent];
  if (setFromIntent && CONFIG.offerSets?.[setFromIntent]) return setFromIntent;

  return 'VIP';
}

module.exports = async function mostrar_ofertas(ctx, payload) {
  const set = pickOfferSet(ctx, payload);
  const ofertas = Array.isArray(CONFIG.offerSets?.[set]) ? CONFIG.offerSets[set] : [];

  if (!ofertas.length) return { ok: false, reason: 'no-offers-for-set', set };

  await ctx.sendText(`Tenho essas opções agora:`, { reply_to_wamid: ctx.replyToWamid });

  for (const o of ofertas) {
    await ctx.delay(200, 650);
    await ctx.sendText(
      `• ${o.titulo} — R$ ${Number(o.preco).toFixed(2).replace('.', ',')}\n${o.resumo}`,
      { reply_to_wamid: ctx.replyToWamid }
    );
  }

  return { ok: true, set, count: ofertas.length };
};

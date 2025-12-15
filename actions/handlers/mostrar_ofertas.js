const { CONFIG } = require('../config');

module.exports = async function mostrar_ofertas(ctx) {
  const ofertas = Array.isArray(CONFIG.ofertas) ? CONFIG.ofertas : [];
  if (!ofertas.length) return { ok: false, reason: 'no-offers' };

  await ctx.sendText(`Tenho essas opções agora:`, { reply_to_wamid: ctx.replyToWamid });
  for (const o of ofertas) {
    await ctx.delay(200, 650);
    await ctx.sendText(
      `• ${o.titulo} — R$ ${Number(o.preco).toFixed(2).replace('.', ',')}\n${o.resumo}`,
      { reply_to_wamid: ctx.replyToWamid }
    );
  }

  return { ok: true, count: ofertas.length };
};

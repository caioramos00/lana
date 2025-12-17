const { CONFIG } = require('../config');

function pickOfferSets(ctx, payload) {
  // 1) Payload explícito (ex: backend forçou)
  if (payload?.sets && Array.isArray(payload.sets)) {
    return payload.sets.filter(s => CONFIG.offerSets?.[s]);
  }

  // 2) Intent detectada (principal)
  const intent = String(ctx?.agent?.intent_detectada || '').trim();
  const setFromIntent = CONFIG.intentToOfferSet?.[intent];

  if (setFromIntent && CONFIG.offerSets?.[setFromIntent]) {
    return [setFromIntent];
  }

  // 3) Fallback seguro
  return ['VIP'];
}

module.exports = async function mostrar_ofertas(ctx, payload = {}) {
  const sets = pickOfferSets(ctx, payload);

  let ofertas = [];

  for (const set of sets) {
    const items = CONFIG.offerSets?.[set];
    if (Array.isArray(items)) {
      ofertas.push(...items);
    }
  }

  // Remove duplicados por id
  ofertas = ofertas.filter(
    (o, i, arr) => arr.findIndex(x => x.id === o.id) === i
  );

  if (!ofertas.length) {
    return { ok: false, reason: 'no-offers', sets };
  }

  // 🔥 Delay humano ANTES de responder
  await ctx.delay(400, 900);

  // 🧠 Monta tudo em UMA mensagem
  const texto = ofertas
    .map(o =>
      `• ${o.titulo} — R$ ${Number(o.preco).toFixed(2).replace('.', ',')}\n${o.resumo}`
    )
    .join('\n\n');

  await ctx.sendText(texto, {
    reply_to_wamid: ctx.replyToWamid
  });

  return {
    ok: true,
    sets,
    count: ofertas.length
  };
};

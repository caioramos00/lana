const { getPixForCtx } = require('../config');

module.exports = async function enviar_pix(ctx) {
  const pix = getPixForCtx(ctx);

  // ✅ tudo configurado aqui (backend), não no prompt
  await ctx.sendText(`Segue o Pix pra confirmar:`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();
  await ctx.sendText(`Chave: ${pix.chave}`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();
  await ctx.sendText(`Recebedor: ${pix.recebedor}`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();
  await ctx.sendText(`Valor: ${pix.valorFmt}`, { reply_to_wamid: ctx.replyToWamid });

  if (pix.mensagemExtra) {
    await ctx.delay();
    await ctx.sendText(pix.mensagemExtra, { reply_to_wamid: ctx.replyToWamid });
  }

  return { ok: true, pix: { valor: pix.valor, fase: ctx.agent?.proxima_fase || null } };
};

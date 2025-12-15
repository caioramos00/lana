const { CONFIG } = require('../config');

module.exports = async function enviar_link_acesso(ctx) {
  const link = CONFIG.links.acesso;
  if (!link) return { ok: false, reason: 'missing-link' };

  await ctx.sendText(`Aqui está seu acesso:`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();
  await ctx.sendText(link, { reply_to_wamid: ctx.replyToWamid });

  return { ok: true };
};

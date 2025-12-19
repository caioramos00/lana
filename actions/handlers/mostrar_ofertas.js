module.exports = async function mostrar_ofertas(ctx, payload = {}) {
  ctx.aiLog?.(`[ACTIONS] mostrar_ofertas desativado (prompt-driven). payload=${JSON.stringify(payload || {})}`);
  return { ok: false, reason: 'disabled_prompt_driven' };
};

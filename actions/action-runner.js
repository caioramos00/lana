const crypto = require('crypto');

function sha1(obj) {
  const s = JSON.stringify(obj ?? {});
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

function normalizePayload(v) {
  if (v === true) return {};               // trigger sem payload
  if (v && typeof v === 'object') return v; // payload futuro
  return { value: v };                      // fallback
}

function ensureLeadActionState(lead, wa_id) {
  if (!lead || typeof lead.getLead !== 'function') return null;
  const st = lead.getLead(wa_id);
  if (!st) return null;
  if (!st.__actions_done) st.__actions_done = {}; // { key: lastHash }
  return st;
}

// handlers: [{ key, priority?, run(ctx) }]
function createActionRunner({ handlers = [], aiLog = () => {} } = {}) {
  const map = new Map();
  for (const h of handlers) {
    if (h?.key && typeof h.run === 'function') map.set(h.key, h);
  }

  async function runAll(actionsObj, ctx) {
    const actions = (actionsObj && typeof actionsObj === 'object') ? actionsObj : {};
    const entries = Object.entries(actions)
      .filter(([, v]) => !!v)
      .map(([key, v]) => ({ key, payload: normalizePayload(v) }));

    // ordena por prioridade (menor primeiro)
    entries.sort((a, b) => {
      const pa = map.get(a.key)?.priority ?? 100;
      const pb = map.get(b.key)?.priority ?? 100;
      return pa - pb;
    });

    const results = [];

    for (const { key, payload } of entries) {
      const handler = map.get(key);

      if (!handler) {
        aiLog(`[ACTIONS] unknown action="${key}" (ignored)`);
        results.push({ key, ok: false, reason: 'unknown_action' });
        continue;
      }

      // dedupe simples por lead (evita “enviar_pix” repetido a cada msg)
      const st = ensureLeadActionState(ctx.lead, ctx.wa_id);
      const hash = sha1(payload);
      if (st && st.__actions_done[key] === hash) {
        aiLog(`[ACTIONS] skip duplicated action="${key}" hash=${hash}`);
        results.push({ key, ok: true, skipped: true, reason: 'duplicate' });
        continue;
      }

      aiLog(`[ACTIONS] start action="${key}" payload=${JSON.stringify(payload)}`);

      try {
        const r = await handler.run({ ...ctx, actionKey: key, payload });
        if (st) st.__actions_done[key] = hash;

        aiLog(`[ACTIONS] ok action="${key}"`);
        results.push({ key, ok: true, result: r ?? null });
      } catch (e) {
        aiLog(`[ACTIONS] fail action="${key}" err=${e?.message || e}`);
        results.push({ key, ok: false, error: e?.message || String(e) });
      }
    }

    return results;
  }

  return { runAll };
}

module.exports = { createActionRunner };

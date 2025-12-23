// actions/runner.js
'use strict';

const crypto = require('crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truthyActionValue(v) {
  if (v === true) return { enabled: true, payload: null };
  if (v && typeof v === 'object') {
    const enabled = (v.enabled === undefined) ? true : !!v.enabled;
    return { enabled, payload: v };
  }
  return { enabled: false, payload: null };
}

function ensureActionState(lead, wa_id) {
  const st = lead.getLead(wa_id);
  if (!st) return null;
  if (!st.__actions) st.__actions = { ran: {} };
  return st.__actions;
}

function hashActionPayload(payload) {
  try {
    const s = JSON.stringify(payload || {});
    return crypto.createHash('sha1').update(s).digest('hex');
  } catch {
    return 'nohash';
  }
}

function createActionRunner({ db, senders, publishState, payments, aiLog = () => { } } = {}) {
  // ✅ enviar_pix agora vem do payments/pix.js
  const pix = require('../payments/pix');
  const enviar_pix = pix?.enviar_pix;

  if (typeof enviar_pix !== 'function') {
    throw new Error('[actions/runner] payments/pix.js must export a function enviar_pix(ctx[, payload])');
  }

  // ✅ whitelist: só executa o que existir aqui
  const handlers = {
    // ❌ mostrar_ofertas removido (agora é 100% via prompt / messages)

    enviar_pix, // ✅ novo local (payments/pix.js)
    enviar_link_acesso: require('./handlers/enviar_link_acesso'),

    enviar_audio: require('./handlers/enviar_audio'),
    enviar_videos: require('./handlers/enviar_videos'),

    enviar_fotos: require('./handlers/enviar_fotos'),
    enviar_audios: require('./handlers/enviar_audios'),

    enviar_imagem: require('./handlers/enviar_previa_foto'),
    enviar_video: require('./handlers/enviar_previa_video'),
  };

  // Anti-spam: impede executar a MESMA action repetidamente num curto período
  const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000; // 2 min

  async function run({ agent, wa_id, inboundPhoneNumberId, lead, replyToWamid, settings }) {
    const acoes = agent?.acoes && typeof agent.acoes === 'object' ? agent.acoes : {};
    const keys = Object.keys(acoes);
    const traceId = `${wa_id}-${Date.now().toString(16)}`;

    console.log(`[ACTIONS][${traceId}] keys=`, keys);
    console.log(`[ACTIONS][${traceId}] acoes=`, JSON.stringify(acoes, null, 2));

    if (!keys.length) return;

    const stActions = ensureActionState(lead, wa_id);
    if (!stActions) return;

    const ctxBase = {
      db,
      payments,
      senders,
      publishState,
      aiLog,
      lead,
      settings: settings || null,
      agent,
      wa_id,
      inboundPhoneNumberId: inboundPhoneNumberId || null,
      replyToWamid: replyToWamid || null,

      // helper: envia texto e já salva no histórico do lead
      sendText: async (text, opts = {}) => {
        const r = await senders.sendMessage(wa_id, text, {
          meta_phone_number_id: inboundPhoneNumberId || null,
          ...(opts.reply_to_wamid ? { reply_to_wamid: opts.reply_to_wamid } : {}),
        });

        if (r?.ok) {
          lead.pushHistory(wa_id, 'assistant', String(text || ''), {
            kind: 'text',
            wamid: r.wamid || '',
            phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
            ts_ms: Date.now(),
            reply_to_wamid: opts.reply_to_wamid || null,
          });
        }
        return r;
      },

      delay: async (minMs = 250, maxMs = 900) => {
        const ms = Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
        await sleep(Math.max(0, ms));
      },
    };

    for (const name of keys) {
      const { enabled, payload } = truthyActionValue(acoes[name]);
      if (!enabled) continue;

      // ✅ bloqueio explícito (garantia total)
      if (name === 'mostrar_ofertas') {
        aiLog(`[ACTIONS] bloqueada: mostrar_ofertas (agora via prompt/messages)`);
        continue;
      }

      const handler = handlers[name];
      if (!handler) {
        console.log(`[ACTIONS][${traceId}] IGNORADA não-whitelisted: ${name}`);
        continue;
      }

      const payloadHash = hashActionPayload(payload);
      const sig = `${name}:${payloadHash}`;

      const last = stActions.ran[sig] || 0;
      const now = Date.now();
      if (now - last < DEFAULT_COOLDOWN_MS) {
        aiLog(`[ACTIONS] cooldown: ${name} (${Math.round((DEFAULT_COOLDOWN_MS - (now - last)) / 1000)}s)`);
        continue;
      }

      stActions.ran[sig] = now;

      try {
        publishState?.({ wa_id, etapa: `ACTION_${name}`, vars: { enabled: true }, ts: now });

        const out = await handler({ ...ctxBase }, payload);

        aiLog(`[ACTIONS] ok: ${name}`, out || '');
      } catch (e) {
        aiLog(`[ACTIONS] FAIL: ${name}`, e?.message || String(e));
      }
    }
  }

  return { run };
}

module.exports = { createActionRunner };

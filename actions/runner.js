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

function createActionRunner({ db, senders, publishState, aiLog = () => { } } = {}) {
  // ✅ whitelist: só executa o que existir aqui
  const handlers = {
    mostrar_ofertas: require('./handlers/mostrar_ofertas'),
    enviar_pix: require('./handlers/enviar_pix'),
    enviar_link_acesso: require('./handlers/enviar_link_acesso'),

    // já existiam
    enviar_audio: require('./handlers/enviar_audio'),
    enviar_video: require('./handlers/enviar_video'),

    // ✅ existem na sua pasta (print)
    enviar_audios: require('./handlers/enviar_audios'),
    enviar_videos: require('./handlers/enviar_videos'),
    enviar_fotos: require('./handlers/enviar_fotos'),

    enviar_vip: require('./handlers/enviar_vip'),
    enviar_assinatura: require('./handlers/enviar_assinatura'),
    enviar_ao_vivo: require('./handlers/enviar_ao_vivo'),
    enviar_upsells: require('./handlers/enviar_upsells'),

    // (gerar_pix_veltrax existe, mas normalmente é usado por enviar_pix; se você chama como action, habilita aqui)
    gerar_pix_veltrax: require('./handlers/gerar_pix_veltrax'),
  };

  // Anti-spam: impede executar a MESMA action repetidamente num curto período
  const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000; // 2 min

  async function run({ agent, wa_id, inboundPhoneNumberId, lead, replyToWamid, settings }) {
    const acoes = agent?.acoes && typeof agent.acoes === 'object' ? agent.acoes : {};
    const keys = Object.keys(acoes);
    if (!keys.length) return;

    const stActions = ensureActionState(lead, wa_id);
    if (!stActions) return;

    const ctxBase = {
      db,
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

      // ✅ imagem (pra enviar_fotos / packs)
      sendImage: async (urlOrItems, captionOrOpts, opts = {}) => {
        const r = await senders.sendImage(wa_id, urlOrItems, captionOrOpts, {
          meta_phone_number_id: inboundPhoneNumberId || null,
          ...(opts.reply_to_wamid ? { reply_to_wamid: opts.reply_to_wamid } : {}),
          ...(opts.delayBetweenMs ? { delayBetweenMs: opts.delayBetweenMs } : {}),
        });

        // histórico (best effort)
        try {
          const ok = Array.isArray(r?.results) ? r.results.every(x => x?.ok) : !!r?.ok;
          if (ok) {
            lead.pushHistory(wa_id, 'assistant', '[media:image]', {
              kind: 'image',
              ts_ms: Date.now(),
              reply_to_wamid: opts.reply_to_wamid || null,
            });
          }
        } catch { }

        return r;
      },

      // ✅ vídeo (pra enviar_video / enviar_videos)
      sendVideo: async (urlOrItems, captionOrOpts, opts = {}) => {
        if (!senders.sendVideo) {
          return { ok: false, reason: 'sendVideo-not-implemented' };
        }

        const r = await senders.sendVideo(wa_id, urlOrItems, captionOrOpts, {
          meta_phone_number_id: inboundPhoneNumberId || null,
          ...(opts.reply_to_wamid ? { reply_to_wamid: opts.reply_to_wamid } : {}),
          ...(opts.delayBetweenMs ? { delayBetweenMs: opts.delayBetweenMs } : {}),
        });

        try {
          const ok = Array.isArray(r?.results) ? r.results.every(x => x?.ok) : !!r?.ok;
          if (ok) {
            lead.pushHistory(wa_id, 'assistant', '[media:video]', {
              kind: 'video',
              ts_ms: Date.now(),
              reply_to_wamid: opts.reply_to_wamid || null,
            });
          }
        } catch { }

        return r;
      },

      // ✅ áudio por URL (pra enviar_audios)
      sendAudioUrl: async (urlOrItems, opts = {}) => {
        if (!senders.sendAudioByLink) {
          return { ok: false, reason: 'sendAudioByLink-not-implemented' };
        }

        const r = await senders.sendAudioByLink(wa_id, urlOrItems, {
          meta_phone_number_id: inboundPhoneNumberId || null,
          ...(opts.reply_to_wamid ? { reply_to_wamid: opts.reply_to_wamid } : {}),
          ...(opts.delayBetweenMs ? { delayBetweenMs: opts.delayBetweenMs } : {}),
        });

        try {
          const ok = Array.isArray(r?.results) ? r.results.every(x => x?.ok) : !!r?.ok;
          if (ok) {
            lead.pushHistory(wa_id, 'assistant', '[media:audio]', {
              kind: 'audio',
              ts_ms: Date.now(),
              reply_to_wamid: opts.reply_to_wamid || null,
            });
          }
        } catch { }

        return r;
      },

      // ✅ doc por URL (se algum fluxo usar)
      sendDocument: async (urlOrItems, captionOrOpts, opts = {}) => {
        if (!senders.sendDocumentByLink) {
          return { ok: false, reason: 'sendDocumentByLink-not-implemented' };
        }

        const r = await senders.sendDocumentByLink(wa_id, urlOrItems, captionOrOpts, {
          meta_phone_number_id: inboundPhoneNumberId || null,
          ...(opts.reply_to_wamid ? { reply_to_wamid: opts.reply_to_wamid } : {}),
          ...(opts.delayBetweenMs ? { delayBetweenMs: opts.delayBetweenMs } : {}),
          ...(opts.filename ? { filename: opts.filename } : {}),
        });

        try {
          const ok = Array.isArray(r?.results) ? r.results.every(x => x?.ok) : !!r?.ok;
          if (ok) {
            lead.pushHistory(wa_id, 'assistant', '[media:document]', {
              kind: 'document',
              ts_ms: Date.now(),
              reply_to_wamid: opts.reply_to_wamid || null,
            });
          }
        } catch { }

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

      const handler = handlers[name];
      if (!handler) {
        aiLog(`[ACTIONS] ignorada (não-whitelisted): ${name}`);
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

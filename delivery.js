const senders = require('./senders');

const {
  callVeniceText,
  callOpenAiText,
  callGrokText,
} = require('./providers');

const {
  readVoiceNoteRuntimeConfig,
  renderVoiceNotePrompt,
  makeAutoShortScriptFromText,
  makeFreeScriptFromOutItems,
  hardCut,
} = require('./voicenote');

const { humanDelayForOutboundText } = require('./runtime');

const _audioRateByUser = new Map();

function _boolLoose(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return def;
}

function _intLoose(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function _readAudioRateLimitSettings(settings) {
  const enabled = _boolLoose(settings?.audio_rl_enabled, false);

  // defaults "bons" caso habilite e o cara esqueça valores
  let max = _intLoose(settings?.audio_rl_max, 30);
  let windowMs = _intLoose(settings?.audio_rl_window_ms, 3600000);

  if (!Number.isFinite(max) || max < 1) max = 30;
  if (!Number.isFinite(windowMs) || windowMs < 1000) windowMs = 3600000;

  // texto opcional no aviso
  const noticeText =
    settings?.audio_rl_notice_text !== undefined && settings?.audio_rl_notice_text !== null
      ? String(settings.audio_rl_notice_text)
      : '';

  return { enabled, max, windowMs, noticeText };
}

function _formatWaitMs(ms) {
  const x = Math.max(0, Math.trunc(ms));
  const s = Math.ceil(x / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

function takeUserAudioSlot({ userKey, max, windowMs, nowMs = Date.now() }) {
  const key = String(userKey || '').trim();
  if (!key) {
    // Sem chave = não limita (ou você pode optar por bloquear). Aqui deixei "passa".
    return { allowed: true, retryMs: 0, used: 0, max, windowMs };
  }

  let bucket = _audioRateByUser.get(key);
  if (!bucket) {
    bucket = { ts: [] };
    _audioRateByUser.set(key, bucket);
  }

  const cutoff = nowMs - windowMs;
  const ts = bucket.ts;

  // purge
  while (ts.length && ts[0] <= cutoff) ts.shift();

  if (ts.length >= max) {
    const oldest = ts[0] || nowMs;
    const retryMs = Math.max(0, (oldest + windowMs) - nowMs);
    return { allowed: false, retryMs, used: ts.length, max, windowMs };
  }

  ts.push(nowMs);
  return { allowed: true, retryMs: 0, used: ts.length, max, windowMs };
}

async function dispatchAssistantOutputs({
  agent,
  wa_id,
  inboundPhoneNumberId,
  leadStore,
  st,
  sendMessage,
  db,
  settings,
  cfg,
  outItems,
  excludeWamids,
  fallbackReplyToWamid,
  askedAudio,
  audioState,
  aiLog = () => { },
}) {
  const wantsPreviewFoto =
    agent?.intent_detectada === 'PEDIDO_PREVIA_FOTO' || !!agent?.acoes?.enviar_imagem;

  const wantsPreviewVideo =
    agent?.intent_detectada === 'PEDIDO_PREVIA_VIDEO' || !!agent?.acoes?.enviar_video;

  const wantsAnyPreview = wantsPreviewFoto || wantsPreviewVideo;

  if (!st.preview_state || typeof st.preview_state !== 'object') {
    st.preview_state = { sent: false, kind: null, ts_ms: null };
  }

  const previewAlreadySent = !!st.preview_state.sent;

  const previewId =
    wantsPreviewFoto
      ? String(settings?.preview_foto_id || 'PREVIA_FOTO').trim()
      : wantsPreviewVideo
        ? String(settings?.preview_video_id || 'PREVIA_VIDEO').trim()
        : null;

  const shouldSendPreviewNow = wantsAnyPreview && !previewAlreadySent && !!previewId;

  if (agent?.acoes && typeof agent.acoes === 'object') {
    agent.acoes.enviar_imagem = false;
    agent.acoes.enviar_video = false;
  }

  const modelWantsAudio = !!agent?.acoes?.enviar_audio;

  if (agent?.acoes && typeof agent.acoes === 'object') {
    agent.acoes.enviar_audio = false;
  }

  const streak = audioState && Number.isFinite(audioState.text_streak_count)
    ? audioState.text_streak_count
    : 0;

  const autoDue = !!cfg.autoAudioEnabled
    && Number.isFinite(cfg.autoAudioAfterMsgs)
    && ((streak + outItems.length) >= cfg.autoAudioAfterMsgs);

  const desiredAudio = !!(askedAudio || modelWantsAudio || autoDue);

  let shouldSendAudio = desiredAudio;
  let audioLimit = null;

  let settingsNow = settings || global.botSettings || null;
  if (!settingsNow && db?.getBotSettings) {
    try { settingsNow = await db.getBotSettings(); } catch { settingsNow = null; }
  }

  if (desiredAudio && settingsNow) {
    const rl = _readAudioRateLimitSettings(settingsNow);
    if (rl.enabled) {
      audioLimit = takeUserAudioSlot({ userKey: wa_id, max: rl.max, windowMs: rl.windowMs });
      if (!audioLimit.allowed) {
        shouldSendAudio = false;
        aiLog(`[AI][AUDIO_RL][${wa_id}] BLOCK used=${audioLimit.used}/${audioLimit.max} retry_in=${_formatWaitMs(audioLimit.retryMs)}`);
      } else {
        aiLog(`[AI][AUDIO_RL][${wa_id}] OK used=${audioLimit.used}/${audioLimit.max}`);
      }
    }
  }

  const suppressTexts = shouldSendAudio;

  if (suppressTexts) {
    let reason = 'AUTO_CURTO';
    if (askedAudio) reason = 'PEDIDO_LEAD';
    else if (modelWantsAudio) reason = 'MODEL';
    aiLog(`[AI][AUDIO_ONLY][${wa_id}] reason=${reason} -> suprimindo ${outItems.length} msg(s) de texto`);
  } else {
    for (let i = 0; i < outItems.length; i++) {
      const { text: msg, reply_to_wamid } = outItems[i];
      if (i > 0) await humanDelayForOutboundText(msg, cfg.outboundDelay);

      const r = await sendMessage(wa_id, msg, {
        meta_phone_number_id: inboundPhoneNumberId || null,
        ...(reply_to_wamid ? { reply_to_wamid } : {}),
      });

      if (!r?.ok) aiLog(`[AI][SEND][${wa_id}] FAIL`, r);

      if (r?.ok) {
        leadStore.pushHistory(wa_id, 'assistant', msg, {
          kind: 'text',
          wamid: r.wamid || '',
          phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
          ts_ms: Date.now(),
          reply_to_wamid: reply_to_wamid || null,
        });
      }

      if (i === 0 && shouldSendPreviewNow) {
        const rPrev = await senders.sendPreviewToLead({
          wa_id,
          preview_id: previewId,
          inboundPhoneNumberId,
        });

        if (!rPrev?.ok) {
          aiLog(`[AI][PREVIEW][${wa_id}] FAIL`, rPrev);
        } else {
          st.preview_state = { sent: true, kind: wantsPreviewFoto ? 'foto' : 'video', ts_ms: Date.now() };

          leadStore.pushHistory(wa_id, 'assistant', `[PREVIEW:${wantsPreviewFoto ? 'foto' : 'video'}]`, {
            kind: 'preview',
            preview_id: previewId,
            ts_ms: Date.now(),
          });
        }
      }
    }
  }

  if (!shouldSendAudio) return;

  let mode = 'AUTO_CURTO';
  if (askedAudio) mode = 'PEDIDO_LEAD';
  else if (modelWantsAudio) mode = 'MODEL';

  let script = '';

  if (mode === 'AUTO_CURTO') {
    const lastText = outItems.length ? outItems[outItems.length - 1].text : '';
    script = makeAutoShortScriptFromText(lastText);
  } else {
    try {
      const settingsNow = settings || global.botSettings || await db.getBotSettings();
      const vn = readVoiceNoteRuntimeConfig(settingsNow, cfg);

      const stForVoice = leadStore.getLead(wa_id);
      let chatStr = '';
      try {
        chatStr = leadStore.buildHistoryString(stForVoice, { excludeWamids });
      } catch {
        chatStr = '';
      }
      chatStr = String(chatStr || '').trim();

      if (suppressTexts && outItems.length) {
        const draft = makeFreeScriptFromOutItems(outItems);
        if (draft) chatStr = `${chatStr}\n\nASSISTANT_DRAFT_PARA_AUDIO:\n${draft}`;
      }

      if (vn.histMaxChars && chatStr.length > vn.histMaxChars) {
        chatStr = chatStr.slice(chatStr.length - vn.histMaxChars);
      }

      const { system, user } = renderVoiceNotePrompt({
        systemPrompt: vn.systemPrompt,
        userTpl: vn.userTpl,
        chatStr,
      });

      const vnProvider = vn.provider;
      const vnModel = vn.model;

      const veniceKeyNow = (settingsNow?.venice_api_key || '').trim();
      const openaiKeyNow = (settingsNow?.openai_api_key || '').trim();
      const grokKeyNow = (settingsNow?.grok_api_key || '').trim();

      const missing =
        !vnModel ||
        (vnProvider === 'venice' ? !veniceKeyNow
          : vnProvider === 'openai' ? !openaiKeyNow
            : !grokKeyNow);

      if (!missing) {
        aiLog(`[AI][VOICE_NOTE] provider=${vnProvider} model=${vnModel} wa_id=${wa_id}`);

        const vnCfg = {
          venice_api_url: cfg.venice_api_url,
          openai_api_url: cfg.openai_api_url,
          grok_api_url: cfg.grok_api_url,
          venice_parameters: cfg.venice_parameters,
          temperature: vn.temperature,
          max_tokens: vn.maxTokens,
          max_output_tokens: vn.maxTokens,
          timeoutMs: vn.timeoutMs,
        };

        const respVn = (vnProvider === 'venice')
          ? await callVeniceText({ apiKey: veniceKeyNow, model: vnModel, systemPrompt: system, userPrompt: user, userId: wa_id, cfg: vnCfg, aiLog })
          : (vnProvider === 'openai')
            ? await callOpenAiText({ apiKey: openaiKeyNow, model: vnModel, systemPrompt: system, userPrompt: user, userId: wa_id, cfg: vnCfg, aiLog })
            : await callGrokText({ apiKey: grokKeyNow, model: vnModel, systemPrompt: system, userPrompt: user, userId: wa_id, cfg: vnCfg, aiLog });

        if (respVn && respVn.status >= 200 && respVn.status < 300) {
          script = String(respVn.content || '').trim();
        }
      }

      if (!script) {
        const fb = String(settingsNow?.voice_note_fallback_text || '').trim();
        script = fb || makeFreeScriptFromOutItems(outItems);
      }

      script = hardCut(script, vn.scriptMaxChars || 650);
    } catch {
      const fb = String(settings?.voice_note_fallback_text || '').trim();
      script = fb || makeFreeScriptFromOutItems(outItems);
    }
  }

  try { await humanDelayForOutboundText(script, cfg.outboundDelay); } catch { }

  const rAudio = await senders.sendTtsVoiceNote(wa_id, script, {
    meta_phone_number_id: inboundPhoneNumberId || null,
    ...(fallbackReplyToWamid ? { reply_to_wamid: fallbackReplyToWamid } : {}),
  });

  if (!rAudio?.ok) {
    aiLog(`[AI][AUDIO][${wa_id}] FAIL mode=${mode}`, rAudio);
    return;
  }

  const audioText = String(rAudio?.tts_text || script || '').trim();

  leadStore.pushHistory(wa_id, 'assistant', `[AUDIO:${mode}]`, {
    kind: 'audio',
    audio_kind: mode,
    audio_text: audioText,
    wamid: rAudio.wamid || '',
    phone_number_id: rAudio.phone_number_id || inboundPhoneNumberId || null,
    ts_ms: Date.now(),
    reply_to_wamid: fallbackReplyToWamid || null,
  });

  aiLog(`[AI][AUDIO][${wa_id}] OK mode=${mode} streak_reset`);
}

module.exports = { dispatchAssistantOutputs };

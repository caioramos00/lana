const axios = require('axios');
const crypto = require('crypto');

const { createActionRunner } = require('./actions');
const senders = require('./senders');

function createAiEngine({ db, sendMessage, aiLog = () => { } } = {}) {
  function sha256Of(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
  }

  const actionRunner = createActionRunner({
    db,
    senders,
    publishState: null, // se você quiser, injete depois (opcional)
    aiLog,
  });

  function looksLikeStrongBuyIntent(userText) {
    const t = String(userText || '').toLowerCase();

    // ✅ gatilhos fortes (ajuste livre)
    // - pedir preço/plano/vip
    // - pedir pix/pagar/fechar
    // - pedir o produto diretamente (foto/vídeo/chamada/mimo etc.)
    return /(\bvip\b|\bplano\b|\bpacote\b|\bpreço\b|\bquanto\b|\bval(or|e)\b|\bmanda\b.*\bpix\b|\bpix\b|\bpagar\b|\bfechou\b|\bquero\b|\bcompro\b|\bassin(at|a)tur\b|\bfoto\b|\bvídeo\b|\bvideo\b|\bchamada\b|\bao vivo\b|\bmimo\b|\blanche\b|\bacademia\b)/i.test(t);
  }

  function shouldBlockSalesActions({ cooldownActive, breakCooldown }) {
    return cooldownActive && !breakCooldown;
  }

  function stripSalesActions(agent, { keepShowOffers = true } = {}) {
    if (!agent || typeof agent !== 'object') return agent;
    if (!agent.acoes || typeof agent.acoes !== 'object') agent.acoes = {};

    // ✅ NÃO bloqueia mostrar_ofertas (a pedido)
    if (!keepShowOffers) agent.acoes.mostrar_ofertas = false;

    // ✅ ainda bloqueia cobrança/entrega automática durante cooldown
    agent.acoes.enviar_pix = false;
    agent.acoes.enviar_link_acesso = false;

    return agent;
  }

  function forceSafeNonSellingReply(agent, fallbackTextList) {
    // Se o modelo ainda “fala de venda” no texto, a gente substitui por mensagens neutras.
    // Isso garante o cooldown de verdade (não só flags).
    const out = {
      messages: [],
      intent_detectada: 'SMALLTALK',
      proxima_fase: 'AQUECENDO',
      acoes: {
        mostrar_ofertas: false,
        enviar_pix: false,
        enviar_link_acesso: false,
        enviar_audio: false,
        enviar_video: false,
      },
    };

    const msgs = Array.isArray(fallbackTextList) ? fallbackTextList : ['to por aqui.', 'me diz uma coisa.'];
    for (let i = 0; i < Math.min(3, msgs.length); i++) {
      out.messages.push({ text: String(msgs[i] || '').trim(), reply_to_wamid: null });
    }

    return out;
  }

  function extractJsonObject(str) {
    const s = String(str || '').trim();
    if (s.startsWith('{') && s.endsWith('}')) return s;

    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) return s.slice(first, last + 1);
    return null;
  }

  function safeParseAgentJson(raw) {
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) return { ok: false, data: null };

    try {
      const obj = JSON.parse(jsonStr);
      if (!obj || typeof obj !== 'object') return { ok: false, data: null };
      if (!Array.isArray(obj.messages)) return { ok: false, data: obj };
      return { ok: true, data: obj };
    } catch {
      return { ok: false, data: null };
    }
  }

  function normalizeReplyId(x) {
    const r = String(x || '').trim();
    return r ? r : null;
  }

  function previewText(s, max = 120) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + `... (len=${t.length})`;
  }

  function extractAround(haystack, needle, radius = 800) {
    const s = String(haystack || '');
    const n = String(needle || '');
    const idx = s.indexOf(n);
    if (idx < 0) return null;
    const start = Math.max(0, idx - 80);
    const end = Math.min(s.length, idx + radius);
    return s.slice(start, end);
  }

  function toNumberOrNull(v) {
    if (v === undefined || v === null) return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  function clampNum(n, { min, max } = {}) {
    if (!Number.isFinite(n)) return null;
    let x = n;
    if (Number.isFinite(min)) x = Math.max(min, x);
    if (Number.isFinite(max)) x = Math.min(max, x);
    return x;
  }

  function clampInt(n, { min, max } = {}) {
    if (!Number.isFinite(n)) return null;
    let x = Math.trunc(n);
    if (Number.isFinite(min)) x = Math.max(min, x);
    if (Number.isFinite(max)) x = Math.min(max, x);
    return x;
  }

  function readAiRuntimeConfig(settings) {
    const s = settings || {};

    const venice_api_url =
      (String(s.venice_api_url || '').trim() || 'https://api.venice.ai/api/v1/chat/completions');

    const venice_temperature =
      clampNum(toNumberOrNull(s.venice_temperature), { min: 0, max: 2 });
    const temperature = (venice_temperature === null) ? 0.7 : venice_temperature;

    const venice_max_tokens =
      clampInt(toNumberOrNull(s.venice_max_tokens), { min: 16, max: 4096 });
    const max_tokens = (venice_max_tokens === null) ? 700 : venice_max_tokens;

    const venice_timeout_ms =
      clampInt(toNumberOrNull(s.venice_timeout_ms), { min: 1000, max: 180000 });
    const timeoutMs = (venice_timeout_ms === null) ? 60000 : venice_timeout_ms;

    const stream = (s.venice_stream === undefined || s.venice_stream === null)
      ? false
      : !!s.venice_stream;

    const userMessage = (String(s.venice_user_message || '').trim()
      || 'Responda exatamente no formato JSON especificado.');

    const venice_parameters = {
      enable_web_search: (String(s.venice_enable_web_search || '').trim() || 'off'),
      include_venice_system_prompt: (s.venice_include_venice_system_prompt === undefined || s.venice_include_venice_system_prompt === null)
        ? false
        : !!s.venice_include_venice_system_prompt,
      enable_web_citations: (s.venice_enable_web_citations === undefined || s.venice_enable_web_citations === null)
        ? false
        : !!s.venice_enable_web_citations,
      enable_web_scraping: (s.venice_enable_web_scraping === undefined || s.venice_enable_web_scraping === null)
        ? false
        : !!s.venice_enable_web_scraping,
    };

    const maxOut = clampInt(toNumberOrNull(s.ai_max_out_messages), { min: 1, max: 10 });
    const max_out_messages = (maxOut === null) ? 3 : maxOut;

    const msg_config_incomplete =
      String(s.ai_error_msg_config || '').trim() || 'Config incompleta no painel (venice key/model/prompt).';
    const msg_generic_error =
      String(s.ai_error_msg_generic || '').trim() || 'Tive um erro aqui. Manda de novo?';
    const msg_parse_error =
      String(s.ai_error_msg_parse || '').trim() || 'Não entendi direito. Me manda de novo?';

    function readDelay(prefix, defaults) {
      const baseMin = clampInt(toNumberOrNull(s[`${prefix}_base_min_ms`]), { min: 0, max: 20000 }) ?? defaults.baseMin;
      const baseMax = clampInt(toNumberOrNull(s[`${prefix}_base_max_ms`]), { min: 0, max: 20000 }) ?? defaults.baseMax;

      const perCharMin = clampInt(toNumberOrNull(s[`${prefix}_per_char_min_ms`]), { min: 0, max: 500 }) ?? defaults.perCharMin;
      const perCharMax = clampInt(toNumberOrNull(s[`${prefix}_per_char_max_ms`]), { min: 0, max: 500 }) ?? defaults.perCharMax;

      const cap = clampInt(toNumberOrNull(s[`${prefix}_cap_ms`]), { min: 0, max: 60000 }) ?? defaults.cap;

      const jitterMin = clampInt(toNumberOrNull(s[`${prefix}_jitter_min_ms`]), { min: 0, max: 20000 }) ?? defaults.jitterMin;
      const jitterMax = clampInt(toNumberOrNull(s[`${prefix}_jitter_max_ms`]), { min: 0, max: 20000 }) ?? defaults.jitterMax;

      const totalMin = clampInt(toNumberOrNull(s[`${prefix}_total_min_ms`]), { min: 0, max: 60000 }) ?? defaults.totalMin;
      const totalMax = clampInt(toNumberOrNull(s[`${prefix}_total_max_ms`]), { min: 0, max: 60000 }) ?? defaults.totalMax;

      return {
        baseMin: Math.min(baseMin, baseMax),
        baseMax: Math.max(baseMin, baseMax),
        perCharMin: Math.min(perCharMin, perCharMax),
        perCharMax: Math.max(perCharMin, perCharMax),
        cap,
        jitterMin: Math.min(jitterMin, jitterMax),
        jitterMax: Math.max(jitterMin, jitterMax),
        totalMin: Math.min(totalMin, totalMax),
        totalMax: Math.max(totalMin, totalMax),
      };
    }

    const inboundDelay = readDelay('ai_in_delay', {
      baseMin: 900,
      baseMax: 1800,
      perCharMin: 18,
      perCharMax: 45,
      cap: 5200,
      jitterMin: 400,
      jitterMax: 1600,
      totalMin: 1600,
      totalMax: 9500,
    });

    const outboundDelay = readDelay('ai_out_delay', {
      baseMin: 450,
      baseMax: 1200,
      perCharMin: 22,
      perCharMax: 55,
      cap: 6500,
      jitterMin: 250,
      jitterMax: 1200,
      totalMin: 900,
      totalMax: 12000,
    });

    const salesCooldownMs =
      clampInt(toNumberOrNull(s.ai_sales_cooldown_ms), { min: 0, max: 7 * 24 * 60 * 60 * 1000 }) ?? (15 * 60 * 1000);

    const salesCooldownMinUserMsgs =
      clampInt(toNumberOrNull(s.ai_sales_cooldown_min_user_msgs), { min: 0, max: 200 }) ?? 12;

    return {
      venice_api_url,
      temperature,
      max_tokens,
      timeoutMs,
      stream,
      venice_parameters,
      userMessage,
      max_out_messages,
      msg_config_incomplete,
      msg_generic_error,
      msg_parse_error,
      inboundDelay,
      outboundDelay,
      salesCooldownMs,
      salesCooldownMinUserMsgs,
    };
  }

  function normalizeAgentMessages(agent, { batchItems, fallbackReplyToWamid, maxOutMessages }) {
    const valid = new Set(
      (batchItems || [])
        .map(b => String(b?.wamid || '').trim())
        .filter(Boolean)
    );

    const raw = Array.isArray(agent?.messages) ? agent.messages : [];
    const out = [];

    for (const item of raw) {
      // compat: formato antigo ["msg1", "msg2"]
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) continue;
        out.push({
          text,
          reply_to_wamid: fallbackReplyToWamid || null,
        });
        continue;
      }

      // novo formato [{text, reply_to_wamid}]
      if (item && typeof item === 'object') {
        const text = String(item.text || '').trim();
        if (!text) continue;

        let reply = normalizeReplyId(item.reply_to_wamid);
        if (reply && !valid.has(reply)) reply = null; // ✅ só aceita wamid do batch

        out.push({ text, reply_to_wamid: reply });
      }
    }

    const limit = Number.isFinite(maxOutMessages) ? maxOutMessages : 3;
    return out.slice(0, Math.max(1, limit));
  }

  function renderSystemPrompt(template, factsObj, historicoStr, msgAtual, batchItems) {
    const safeFacts = JSON.stringify(factsObj || {}, null, 2);
    const safeHist = String(historicoStr || '');
    const safeMsg = String(msgAtual || '');
    const safeBatch = JSON.stringify(batchItems || [], null, 2);

    return String(template || '')
      .replace(/\{FACTS_JSON\}/g, safeFacts)
      .replace(/\{HISTORICO\}/g, safeHist)
      .replace(/\{MENSAGEM_ATUAL\}/g, safeMsg)
      .replace(/\{BATCH_ITEMS_JSON\}/g, safeBatch); // ✅ NÍVEL 3
  }

  function buildFactsJson(st, inboundPhoneNumberId) {
    const now = Date.now();
    const lastTs = st?.last_user_ts ? st.last_user_ts : null;
    const hoursSince = lastTs ? Math.max(0, (now - lastTs) / 3600000) : 0;

    const totalUserMsgs = (st?.history || []).filter(x => x.role === 'user').length;
    const status_lead = totalUserMsgs <= 1 ? 'NOVO' : 'EM_CONVERSA';

    const cd = st?.cooldown || null;
    const cdUntil = cd && Number.isFinite(cd.active_until_ts) ? cd.active_until_ts : null;
    const cooldown_ativo = cdUntil ? (now < cdUntil) : false;
    const cooldown_restante_ms = cooldown_ativo ? Math.max(0, cdUntil - now) : 0;

    return {
      status_lead,
      horas_desde_ultima_mensagem_usuario: Math.round(hoursSince * 100) / 100,
      motivo_interacao: 'RESPOSTA_USUARIO',
      ja_comprou_vip: false,
      lead_pediu_pra_parar: false,
      meta_phone_number_id: inboundPhoneNumberId || st?.meta_phone_number_id || null,

      cooldown_ativo,
      cooldown_restante_ms,
      cooldown_msgs_desde_inicio: cd ? (cd.msgs_since_start || 0) : 0,
      cooldown_motivo: cd ? (cd.last_reason || null) : null,
    };
  }

  // ===== delay humano =====
  function randInt(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function humanDelayForInboundText(userText, cfg) {
    const t = String(userText || '');
    const chars = t.length;

    const base = randInt(cfg.baseMin, cfg.baseMax);
    const perChar = randInt(cfg.perCharMin, cfg.perCharMax);
    const reading = Math.min(chars * perChar, cfg.cap);
    const jitter = randInt(cfg.jitterMin, cfg.jitterMax);

    let total = base + reading + jitter;
    total = Math.max(cfg.totalMin, Math.min(cfg.totalMax, total));
    await sleep(total);
  }

  async function humanDelayForOutboundText(outText, cfg) {
    const t = String(outText || '');
    const chars = t.length;

    const base = randInt(cfg.baseMin, cfg.baseMax);
    const perChar = randInt(cfg.perCharMin, cfg.perCharMax);
    const typing = Math.min(chars * perChar, cfg.cap);
    const jitter = randInt(cfg.jitterMin, cfg.jitterMax);

    let total = base + typing + jitter;
    total = Math.max(cfg.totalMin, Math.min(cfg.totalMax, total));
    await sleep(total);
  }

  // ===== LOG helpers (SEM depender de ENV) =====
  function truncateForLog(s, max) {
    const t = String(s || '');
    if (t.length <= max) return t;
    return t.slice(0, max) + `... (truncated chars=${t.length})`;
  }

  function logAiRequest({ wa_id, inboundPhoneNumberId, facts, historicoStr, msgParaPrompt, rendered, model, batchItems, userMessage }) {
    const histMax = 2500;
    const msgMax = 2500;
    const factsMax = 4000;

    const sha = sha256Of(rendered || '');

    aiLog(`[AI][REQUEST][${wa_id}] model=${model || ''} phone_number_id=${inboundPhoneNumberId || ''}`);
    aiLog(`[AI][REQUEST][${wa_id}] SYSTEM_PROMPT (omitted) chars=${(rendered || '').length} sha256=${sha}`);

    aiLog(`[AI][REQUEST][${wa_id}] FACTS_JSON:\n${truncateForLog(JSON.stringify(facts || {}, null, 2), factsMax)}`);
    aiLog(`[AI][REQUEST][${wa_id}] HISTORICO_PREVIEW:\n${truncateForLog(historicoStr || '', histMax)}`);
    aiLog(`[AI][REQUEST][${wa_id}] MENSAGEM_PARA_PROMPT:\n${truncateForLog(msgParaPrompt || '', msgMax)}`);

    const batchMax = 4000;
    const batch = Array.isArray(batchItems) ? batchItems : [];
    aiLog(`[AI][REQUEST][${wa_id}] BATCH_ITEMS count=${batch.length}`);
    aiLog(`[AI][REQUEST][${wa_id}] BATCH_ITEMS_JSON:\n${truncateForLog(JSON.stringify(batch, null, 2), batchMax)}`);

    const batchMini = batch.map((b, i) => ({
      i,
      wamid: String(b?.wamid || '').slice(0, 28) + '...',
      text: previewText(b?.text || '', 80),
      ts_ms: b?.ts_ms ?? null,
    }));
    aiLog(`[AI][REQUEST][${wa_id}] BATCH_ITEMS_MINI:\n${truncateForLog(JSON.stringify(batchMini, null, 2), 2200)}`);

    const renderedStr = String(rendered || '');
    const hasPlaceholder = renderedStr.includes('{BATCH_ITEMS_JSON}');
    const anyWamidInRendered = batch.some(b => {
      const w = String(b?.wamid || '').trim();
      return w && renderedStr.includes(w);
    });
    aiLog(`[AI][REQUEST][${wa_id}] RENDER_CHECK placeholderLeft=${hasPlaceholder} containsAnyWamid=${anyWamidInRendered}`);

    const batchSnippet = extractAround(renderedStr, 'BATCH', 1200);
    if (batchSnippet) {
      aiLog(`[AI][REQUEST][${wa_id}] RENDER_SNIPPET_NEAR_BATCH:\n${truncateForLog(batchSnippet, 1800)}`);
    }

    aiLog(`[AI][REQUEST][${wa_id}] VENICE_MESSAGES:`);
    aiLog(JSON.stringify([
      { role: 'system', content: `[OMITTED] chars=${(rendered || '').length} sha256=${sha}` },
      { role: 'user', content: userMessage || 'Responda exatamente no formato JSON especificado.' },
    ], null, 2));
  }

  async function callVeniceChat({ apiKey, model, systemPromptRendered, userId, cfg }) {
    const url = cfg.venice_api_url;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPromptRendered },
        { role: 'user', content: cfg.userMessage },
      ],
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      response_format: { type: 'json_object' },
      user: userId || undefined,
      venice_parameters: cfg.venice_parameters,
      stream: !!cfg.stream,
    };

    const r = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: cfg.timeoutMs,
      validateStatus: () => true,
    });

    aiLog(`[AI][RESPONSE] http=${r.status}`);

    const content = r.data?.choices?.[0]?.message?.content ?? '';
    aiLog(`[AI][RESPONSE][CONTENT]\n${content}`);

    aiLog(JSON.stringify({
      id: r.data?.id,
      model: r.data?.model,
      created: r.data?.created,
      usage: r.data?.usage,
      finish_reason: r.data?.choices?.[0]?.finish_reason,
    }, null, 2));

    return { status: r.status, data: r.data };
  }

  function leadAskedForAudio(userText) {
    const t = String(userText || '').toLowerCase();
    return /(\báudio\b|\baudio\b|\bmanda( um)? áudio\b|\bmanda( um)? audio\b|\bvoz\b|\bme manda.*(áudio|audio)\b|\bgrava\b)/i.test(t);
  }

  function stripUrls(text) {
    return String(text || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  }

  function makeAutoShortScriptFromText(text) {
    const clean = stripUrls(text);
    if (!clean) return 'tlg. é isso.';

    const words = clean.split(/\s+/).filter(Boolean);
    const cut = words.slice(0, 12).join(' ');
    return (cut.endsWith('.') || cut.endsWith('!') || cut.endsWith('?')) ? cut : (cut + '.');
  }

  function makeFreeScriptFromOutItems(outItems) {
    const texts = (Array.isArray(outItems) ? outItems : [])
      .map(x => String(x?.text || '').trim())
      .filter(Boolean);

    const joined = stripUrls(texts.join(' ')).trim();
    if (!joined) return 'fala aí.';

    const maxChars = 4500;
    return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
  }

  async function handleInboundBlock({
    wa_id,
    inboundPhoneNumberId,
    blocoText,
    mensagemAtualBloco,
    excludeWamids,
    replyToWamid,
    batch_items,

    historicoStrSnapshot,
    historyMaxTsMs,

    lead,
  }) {
    if (!lead || typeof lead.getLead !== 'function') {
      aiLog('[AI][ERROR] leadStore não foi injetado no handleInboundBlock');
      return;
    }

    const st = lead.getLead(wa_id);
    const cd = (typeof lead.getCooldownState === 'function') ? lead.getCooldownState(wa_id) : null;
    if (!st) return;

    const settings = global.botSettings || await db.getBotSettings();
    const veniceApiKey = (settings?.venice_api_key || '').trim();
    const veniceModel = (settings?.venice_model || '').trim();
    const systemPromptTpl = (settings?.system_prompt || '').trim();

    const cfg = readAiRuntimeConfig(settings);

    if (!veniceApiKey || !veniceModel || !systemPromptTpl) {
      await sendMessage(wa_id, cfg.msg_config_incomplete, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const bloco = String(blocoText || '').trim();
    const atual = String(mensagemAtualBloco || '').trim();

    const userTextForIntent = (atual || bloco || '').trim();
    const askedAudio = leadAskedForAudio(userTextForIntent);

    const audioState = (typeof lead.getAudioState === 'function')
      ? lead.getAudioState(wa_id)
      : (st.audio_policy || { text_streak_count: 0, next_audio_at: 12 });

    const cooldownActive = (typeof lead.isCooldownActive === 'function') ? lead.isCooldownActive(wa_id) : false;
    const breakCooldown = looksLikeStrongBuyIntent(userTextForIntent);

    if (cooldownActive) {
      aiLog(`[AI][COOLDOWN][${wa_id}] active=YES break=${breakCooldown ? 'YES' : 'NO'} msgs_since=${cd?.msgs_since_start || 0} until=${cd?.active_until_ts || ''}`);
    }

    await humanDelayForInboundText(bloco || atual, cfg.inboundDelay);

    const facts = buildFactsJson(st, inboundPhoneNumberId);

    facts.audio_policy = {
      lead_pediu_audio: !!askedAudio,
      text_streak_count: audioState?.text_streak_count ?? 0,
      next_audio_at: audioState?.next_audio_at ?? null,
      auto_min: 10,
      auto_max: 15,
      auto_max_seconds: 5,
    };

    const historicoStr = (typeof historicoStrSnapshot === 'string')
      ? historicoStrSnapshot
      : lead.buildHistoryString(st, { excludeWamids });

    const msgParaPrompt = (bloco && atual && bloco !== atual)
      ? `BLOCO_USUARIO:\n${bloco}\n\nMENSAGEM_ATUAL_BLOCO:\n${atual}`
      : (atual || bloco);

    const rendered = renderSystemPrompt(systemPromptTpl, facts, historicoStr, msgParaPrompt, batch_items);

    aiLog(`[AI][CTX][${wa_id}] phone_number_id=${inboundPhoneNumberId || ''}`);

    if (typeof historicoStrSnapshot === 'string') {
      aiLog(`[AI][CTX][${wa_id}] historySnapshot=ON cutoffTsMs=${Number.isFinite(historyMaxTsMs) ? historyMaxTsMs : ''}`);
    }

    aiLog(`[AI][SYSTEM_PROMPT_RENDERED] (omitted) chars=${(rendered || '').length} sha256=${sha256Of(rendered || '')}`);

    logAiRequest({
      wa_id,
      inboundPhoneNumberId,
      facts,
      historicoStr,
      msgParaPrompt,
      rendered,
      model: veniceModel,
      batchItems: batch_items,
      userMessage: cfg.userMessage,
    });

    const venice = await callVeniceChat({
      apiKey: veniceApiKey,
      model: veniceModel,
      systemPromptRendered: rendered,
      userId: wa_id,
      cfg,
    });

    if (!venice || venice.status < 200 || venice.status >= 300) {
      await sendMessage(wa_id, cfg.msg_generic_error, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const content = venice?.data?.choices?.[0]?.message?.content || '';
    const parsed = safeParseAgentJson(content);

    if (!parsed.ok) {
      await sendMessage(wa_id, cfg.msg_parse_error, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const agent = parsed.data;

    // ✅ se o modelo não veio no formato esperado, a gente cai fora
    if (!agent || typeof agent !== 'object') {
      await sendMessage(wa_id, cfg.msg_parse_error, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const blockSales = shouldBlockSalesActions({ cooldownActive, breakCooldown });

    if (blockSales) {
      // ✅ durante cooldown a gente só impede PIX/LINK
      // ✅ mas deixa mostrar_ofertas passar normal
      stripSalesActions(agent, { keepShowOffers: true });

      // ❌ não substitui mensagens (senão mata conversão e trava UX)
    }

    const fallbackReplyToWamid = String(replyToWamid || '').trim() || null;

    const outItems = normalizeAgentMessages(agent, {
      batchItems: batch_items,
      fallbackReplyToWamid,
      maxOutMessages: cfg.max_out_messages,
    });

    // envia mensagens (se houver)
    for (let i = 0; i < outItems.length; i++) {
      const { text: msg, reply_to_wamid } = outItems[i];
      if (i > 0) await humanDelayForOutboundText(msg, cfg.outboundDelay);

      const r = await sendMessage(wa_id, msg, {
        meta_phone_number_id: inboundPhoneNumberId || null,
        ...(reply_to_wamid ? { reply_to_wamid } : {}),
      });

      if (!r?.ok) aiLog(`[AI][SEND][${wa_id}] FAIL`, r);

      if (r?.ok) {
        lead.pushHistory(wa_id, 'assistant', msg, {
          kind: 'text',
          wamid: r.wamid || '',
          phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
          ts_ms: Date.now(),
          reply_to_wamid: reply_to_wamid || null,
        });
      }
    }

    const stAfterTexts = lead.getLead(wa_id);
    const aAfter = (typeof lead.getAudioState === 'function')
      ? lead.getAudioState(wa_id)
      : (stAfterTexts?.audio_policy || null);

    const modelWantsAudio = !!agent?.acoes?.enviar_audio;

    // se actions.js também mandar áudio via enviar_audio, a gente neutraliza aqui pra não duplicar.
    // (aqui o backend vira "fonte da verdade" do envio de áudio)
    if (agent?.acoes && typeof agent.acoes === 'object') {
      agent.acoes.enviar_audio = false;
    }

    const autoDue =
      !askedAudio &&
      !modelWantsAudio &&
      aAfter &&
      Number.isFinite(aAfter.text_streak_count) &&
      Number.isFinite(aAfter.next_audio_at) &&
      aAfter.text_streak_count >= aAfter.next_audio_at;

    const shouldSendAudio = askedAudio || modelWantsAudio || autoDue;

    if (shouldSendAudio) {
      let mode = 'AUTO_CURTO';
      if (askedAudio) mode = 'PEDIDO_LEAD';
      else if (modelWantsAudio) mode = 'MODEL';

      // script
      let script = '';
      if (mode === 'AUTO_CURTO') {
        const lastText = outItems.length ? outItems[outItems.length - 1].text : '';
        script = makeAutoShortScriptFromText(lastText);
      } else {
        script = makeFreeScriptFromOutItems(outItems);
      }

      // delay humano antes do áudio (opcional, mas deixa natural)
      try {
        await humanDelayForOutboundText(script, cfg.outboundDelay);
      } catch { }

      const rAudio = await senders.sendTtsVoiceNote(wa_id, script, {
        meta_phone_number_id: inboundPhoneNumberId || null,
        ...(fallbackReplyToWamid ? { reply_to_wamid: fallbackReplyToWamid } : {}),
      });

      if (!rAudio?.ok) {
        aiLog(`[AI][AUDIO][${wa_id}] FAIL mode=${mode}`, rAudio);
      } else {
        // registra no histórico como "não-text" pra resetar streak automaticamente
        lead.pushHistory(wa_id, 'assistant', `[AUDIO:${mode}]`, {
          kind: 'audio',
          audio_kind: mode,
          wamid: rAudio.wamid || '',
          phone_number_id: rAudio.phone_number_id || inboundPhoneNumberId || null,
          ts_ms: Date.now(),
          reply_to_wamid: fallbackReplyToWamid || null,
        });

        aiLog(`[AI][AUDIO][${wa_id}] OK mode=${mode} streak_reset next_at=${lead.getAudioState(wa_id)?.next_audio_at}`);
      }
    }

    // ✅ inicia cooldown quando houver ação de venda relevante
    // (mesmo que não tenha mensagem, o modelo pode ter tentado acionar)
    const triedShowOffers = !!agent?.acoes?.mostrar_ofertas;
    const triedPix = !!agent?.acoes?.enviar_pix;
    const triedLink = !!agent?.acoes?.enviar_link_acesso;

    if (!blockSales) {
      // ✅ inicia cooldown só quando tentou PIX/LINK (não por mostrar_ofertas)
      if ((triedPix || triedLink) && typeof lead.startCooldown === 'function') {
        const reason = triedPix ? 'pix' : 'link';
        lead.startCooldown(wa_id, { durationMs: cfg.salesCooldownMs, reason });
      }

      // ✅ se o user deu gatilho forte, encerra cooldown (como já fazia)
      if (breakCooldown && typeof lead.stopCooldown === 'function') {
        lead.stopCooldown(wa_id, { reason: 'break_by_user_intent' });
      }
    }

    // ✅ roda actions mesmo que não tenha messages
    await actionRunner.run({
      agent,
      wa_id,
      inboundPhoneNumberId,
      lead,
      replyToWamid: fallbackReplyToWamid,
      batch_items,
      settings,
    });

  }

  return { handleInboundBlock };
}

module.exports = { createAiEngine };

const { createActionRunner } = require('./actions');
const senders = require('./senders');
const dbModule = require('./db');
const { publishState } = require('./stream/events-bus');
const { CONFIG } = require('./actions/config');
const { createPaymentsModule } = require('./payments/payment-module');

const {
  callVeniceChat,
  callOpenAiResponses,
  callGrokChat,
} = require('./providers');

const { leadAskedForAudio } = require('./voicenote');

const {
  readAiRuntimeConfig,
  humanDelayForInboundText,
  logAiRequest,
} = require('./runtime');

const { dispatchAssistantOutputs } = require('./delivery');

function createAiEngine({ db = dbModule, sendMessage, aiLog = () => { }, payments: injectedPayments } = {}) {
  const hasInjectedPayments = !!injectedPayments;
  const _paymentsByLeadStore = new WeakMap();
  const _runnerByLeadStore = new WeakMap();

  const _singletonRunner = hasInjectedPayments
    ? createActionRunner({ db, senders, publishState, payments: injectedPayments, aiLog })
    : null;

  function getPaymentsForLeadStore(leadStore) {
    if (hasInjectedPayments) return injectedPayments;

    if (!leadStore || (typeof leadStore !== 'object' && typeof leadStore !== 'function')) {
      return createPaymentsModule({ db, lead: leadStore, publishState });
    }

    let p = _paymentsByLeadStore.get(leadStore);
    if (!p) {
      p = createPaymentsModule({ db, lead: leadStore, publishState });
      _paymentsByLeadStore.set(leadStore, p);
    }
    return p;
  }

  function getActionRunnerForLeadStore(leadStore) {
    if (hasInjectedPayments) return _singletonRunner;

    if (!leadStore || (typeof leadStore !== 'object' && typeof leadStore !== 'function')) {
      return createActionRunner({
        db,
        senders,
        publishState,
        payments: getPaymentsForLeadStore(leadStore),
        aiLog,
      });
    }

    let r = _runnerByLeadStore.get(leadStore);
    if (!r) {
      r = createActionRunner({
        db,
        senders,
        publishState,
        payments: getPaymentsForLeadStore(leadStore),
        aiLog,
      });
      _runnerByLeadStore.set(leadStore, r);
    }
    return r;
  }

  function looksLikeStrongBuyIntent(userText) {
    const t = String(userText || '').toLowerCase();
    return /(\bvip\b|\bplano\b|\bpacote\b|\bpreço\b|\bquanto\b|\bval(or|e)\b|\bmanda\b.*\bpix\b|\bpix\b|\bpagar\b|\bfechou\b|\bquero\b|\bcompro\b|\bassin(at|a)tur\b|\bfoto\b|\bvídeo\b|\bvideo\b|\bchamada\b|\bao vivo\b|\bmimo\b|\blanche\b|\bacademia\b)/i.test(t);
  }

  function shouldBlockSalesActions({ cooldownActive, breakCooldown }) {
    return cooldownActive && !breakCooldown;
  }

  function stripSalesActions(agent, { keepShowOffers = true } = {}) {
    if (!agent || typeof agent !== 'object') return agent;
    if (!agent.acoes || typeof agent.acoes !== 'object') agent.acoes = {};
    if (!keepShowOffers) agent.acoes.mostrar_ofertas = false;
    agent.acoes.enviar_pix = false;
    agent.acoes.enviar_link_acesso = false;
    return agent;
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
      return { ok: true, data: obj };
    } catch {
      return { ok: false, data: null };
    }
  }

  function normalizeReplyId(x) {
    const r = String(x || '').trim();
    return r ? r : null;
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
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) continue;
        out.push({ text, reply_to_wamid: fallbackReplyToWamid || null });
        continue;
      }

      if (item && typeof item === 'object') {
        const text = String(item.text || '').trim();
        if (!text) continue;

        let reply = normalizeReplyId(item.reply_to_wamid);
        if (reply && !valid.has(reply)) reply = null;

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
      .replace(/\{BATCH_ITEMS_JSON\}/g, safeBatch);
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

    const offersForPrompt = {
      offerSets: CONFIG.offerSets || {},
      intentToOfferSet: CONFIG.intentToOfferSet || {},
    };

    const ps = st?.payments_state || {};
    const pending = ps?.pending || null;
    const lastPaid = ps?.last_paid || null;

    return {
      status_lead,
      horas_desde_ultima_mensagem_usuario: Math.round(hoursSince * 100) / 100,
      motivo_interacao: 'RESPOSTA_USUARIO',
      ja_comprou_vip: !!(st?.ja_comprou_vip || st?.payments_state?.last_paid && /vip/i.test(String(st?.payments_state?.last_paid?.offer_id || ''))),
      lead_pediu_pra_parar: false,
      meta_phone_number_id: inboundPhoneNumberId || st?.meta_phone_number_id || null,
      cooldown_ativo,
      cooldown_restante_ms,
      cooldown_msgs_desde_inicio: cd ? (cd.msgs_since_start || 0) : 0,
      cooldown_motivo: cd ? (cd.last_reason || null) : null,
      catalogo_ofertas: offersForPrompt,
      pagamento: {
        tem_pix_pendente: !!pending,
        pix_status: pending?.status || null,
        pix_offer_id: pending?.offer_id || null,
        pix_valor: pending?.amount ?? null,
        pix_provider: pending?.provider || null,
        pix_external_id: pending?.external_id || null,
        pix_transaction_id: pending?.transaction_id || null,
        pago: !!lastPaid,
        pago_offer_id: lastPaid?.offer_id || null,
        pago_valor: lastPaid?.amount ?? null,
        pago_provider: lastPaid?.provider || null,
        pago_ts_ms: lastPaid?.paid_ts_ms || null,
        vip_link_enviado: !!ps?.vip_link_sent,
      },
    };
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
    lead: leadStore,
  }) {
    if (!leadStore || typeof leadStore.getLead !== 'function') {
      aiLog('[AI][ERROR] leadStore não foi injetado no handleInboundBlock (ou não tem getLead)');
      return;
    }

    const actionRunner = getActionRunnerForLeadStore(leadStore);

    const st = leadStore.getLead(wa_id);
    const cd = (typeof leadStore.getCooldownState === 'function') ? leadStore.getCooldownState(wa_id) : null;
    if (!st) return;

    const settings = global.botSettings || await db.getBotSettings();
    const systemPromptTpl = (settings?.system_prompt || '').trim();
    const cfg = readAiRuntimeConfig(settings);

    const provider = cfg.ai_provider;

    const veniceApiKey = (settings?.venice_api_key || '').trim();
    const veniceModel = (settings?.venice_model || '').trim();

    const openaiApiKey = (settings?.openai_api_key || '').trim();
    const openaiModel = (settings?.openai_model || '').trim();

    const grokApiKey = (settings?.grok_api_key || '').trim();
    const grokModel = (settings?.grok_model || '').trim();

    const missingCore =
      !systemPromptTpl ||
      (provider === 'venice' ? (!veniceApiKey || !veniceModel)
        : provider === 'openai' ? (!openaiApiKey || !openaiModel)
          : (!grokApiKey || !grokModel));

    if (missingCore) {
      await sendMessage(wa_id, cfg.msg_config_incomplete, { meta_phone_number_id: inboundPhoneNumberId || null });
      return;
    }

    const bloco = String(blocoText || '').trim();
    const atual = String(mensagemAtualBloco || '').trim();

    const userTextForIntent = (atual || bloco || '').trim();
    const askedAudio = leadAskedForAudio(userTextForIntent);

    const audioState = (typeof leadStore.getAudioState === 'function')
      ? leadStore.getAudioState(wa_id)
      : (st.audio_policy || { text_streak_count: 0 });

    const cooldownActive = (typeof leadStore.isCooldownActive === 'function') ? leadStore.isCooldownActive(wa_id) : false;
    const breakCooldown = looksLikeStrongBuyIntent(userTextForIntent);

    if (cooldownActive) {
      aiLog(`[AI][COOLDOWN][${wa_id}] active=YES break=${breakCooldown ? 'YES' : 'NO'} msgs_since=${cd?.msgs_since_start || 0} until=${cd?.active_until_ts || ''}`);
    }

    await humanDelayForInboundText(bloco || atual, cfg.inboundDelay);

    const facts = buildFactsJson(st, inboundPhoneNumberId);
    facts.audio_policy = {
      lead_pediu_audio: !!askedAudio,
      auto_enabled: cfg.autoAudioEnabled,
      auto_after_msgs: cfg.autoAudioAfterMsgs,
      text_streak_count: audioState?.text_streak_count ?? 0,
      auto_max_seconds: 5,
    };

    const historicoStr = (typeof historicoStrSnapshot === 'string')
      ? historicoStrSnapshot
      : leadStore.buildHistoryString(st, { excludeWamids });

    const msgParaPrompt = (bloco && atual && bloco !== atual)
      ? `BLOCO_USUARIO:\n${bloco}\n\nMENSAGEM_ATUAL_BLOCO:\n${atual}`
      : (atual || bloco);

    const rendered = renderSystemPrompt(systemPromptTpl, facts, historicoStr, msgParaPrompt, batch_items);

    aiLog(`[AI][CTX][${wa_id}] provider=${provider} phone_number_id=${inboundPhoneNumberId || ''}`);

    if (typeof historicoStrSnapshot === 'string') {
      aiLog(`[AI][CTX][${wa_id}] historySnapshot=ON cutoffTsMs=${Number.isFinite(historyMaxTsMs) ? historyMaxTsMs : ''}`);
    }

    const modelUsed =
      (provider === 'venice') ? veniceModel
        : (provider === 'openai') ? openaiModel
          : grokModel;

    const endpointUsed =
      (provider === 'venice') ? cfg.venice_api_url
        : (provider === 'openai') ? cfg.openai_api_url
          : cfg.grok_api_url;

    logAiRequest({
      provider,
      wa_id,
      inboundPhoneNumberId,
      facts,
      historicoStr,
      msgParaPrompt,
      rendered,
      model: modelUsed,
      batchItems: batch_items,
      userMessage: cfg.userMessage,
      endpoint: endpointUsed,
      aiLog,
    });

    const resp = (provider === 'venice')
      ? await callVeniceChat({ apiKey: veniceApiKey, model: veniceModel, systemPromptRendered: rendered, userId: wa_id, cfg, aiLog })
      : (provider === 'openai')
        ? await callOpenAiResponses({ apiKey: openaiApiKey, model: openaiModel, systemPromptRendered: rendered, userId: wa_id, cfg, aiLog })
        : await callGrokChat({ apiKey: grokApiKey, model: grokModel, systemPromptRendered: rendered, userId: wa_id, cfg, aiLog });

    if (!resp || resp.status < 200 || resp.status >= 300) {
      await sendMessage(wa_id, cfg.msg_generic_error, { meta_phone_number_id: inboundPhoneNumberId || null });
      return;
    }

    const content = resp.content || '';
    const parsed = safeParseAgentJson(content);

    if (!parsed.ok) {
      await sendMessage(wa_id, cfg.msg_parse_error, { meta_phone_number_id: inboundPhoneNumberId || null });
      return;
    }

    const agent = parsed.data;
    const traceId = `${wa_id}-${Date.now().toString(16)}`;

    aiLog(`[PREVIEW][${traceId}] agent.intent=${agent?.intent_detectada || ''} fase=${agent?.proxima_fase || ''}`);
    aiLog(`[PREVIEW][${traceId}] acoes= ${JSON.stringify(agent?.acoes || {}, null, 2)}`);

    if (!agent || typeof agent !== 'object') {
      await sendMessage(wa_id, cfg.msg_parse_error, { meta_phone_number_id: inboundPhoneNumberId || null });
      return;
    }

    if (!agent.acoes || typeof agent.acoes !== 'object') agent.acoes = {};
    agent.acoes.mostrar_ofertas = false;

    const blockSales = shouldBlockSalesActions({ cooldownActive, breakCooldown });
    if (blockSales) stripSalesActions(agent, { keepShowOffers: true });

    const fallbackReplyToWamid = String(replyToWamid || '').trim() || null;

    const outItems = normalizeAgentMessages(agent, {
      batchItems: batch_items,
      fallbackReplyToWamid,
      maxOutMessages: cfg.max_out_messages,
    });

    await dispatchAssistantOutputs({
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
      aiLog,
    });

    const triedPix = !!agent?.acoes?.enviar_pix;
    const triedLink = !!agent?.acoes?.enviar_link_acesso;

    if (!blockSales) {
      if ((triedPix || triedLink) && typeof leadStore.startCooldown === 'function') {
        const reason = triedPix ? 'pix' : 'link';
        leadStore.startCooldown(wa_id, { durationMs: cfg.salesCooldownMs, reason, minUserMsgs: cfg.salesCooldownMinUserMsgs });
      }

      if (breakCooldown && typeof leadStore.stopCooldown === 'function') {
        leadStore.stopCooldown(wa_id, { reason: 'break_by_user_intent' });
      }
    }

    aiLog(`[PREVIEW][${traceId}] calling actionRunner.run...`);

    await actionRunner.run({
      agent,
      wa_id,
      inboundPhoneNumberId,
      lead: leadStore,
      replyToWamid: fallbackReplyToWamid,
      batch_items,
      settings,
    });

    aiLog(`[PREVIEW][${traceId}] actionRunner.run finished`);
  }

  return { handleInboundBlock };
}

module.exports = { createAiEngine };

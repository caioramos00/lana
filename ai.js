const axios = require('axios');
const crypto = require('crypto');

function createAiEngine({ db, sendMessage, aiLog = () => {} } = {}) {
  function sha256Of(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
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

  function renderSystemPrompt(template, factsObj, historicoStr, msgAtual) {
    const safeFacts = JSON.stringify(factsObj || {}, null, 2);
    const safeHist = String(historicoStr || '');
    const safeMsg = String(msgAtual || '');

    return String(template || '')
      .replace(/\{FACTS_JSON\}/g, safeFacts)
      .replace(/\{HISTORICO\}/g, safeHist)
      .replace(/\{MENSAGEM_ATUAL\}/g, safeMsg);
  }

  function buildFactsJson(st, inboundPhoneNumberId) {
    const now = Date.now();
    const lastTs = st?.last_user_ts ? st.last_user_ts : null;
    const hoursSince = lastTs ? Math.max(0, (now - lastTs) / 3600000) : 0;

    const totalUserMsgs = (st?.history || []).filter(x => x.role === 'user').length;
    const status_lead = totalUserMsgs <= 1 ? 'NOVO' : 'EM_CONVERSA';

    return {
      status_lead,
      horas_desde_ultima_mensagem_usuario: Math.round(hoursSince * 100) / 100,
      motivo_interacao: 'RESPOSTA_USUARIO',
      ja_comprou_vip: false,
      lead_pediu_pra_parar: false,
      meta_phone_number_id: inboundPhoneNumberId || st?.meta_phone_number_id || null,
    };
  }

  // ===== delay humano =====
  function randInt(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function humanDelayForInboundText(userText) {
    const t = String(userText || '');
    const chars = t.length;

    const base = randInt(900, 1800);
    const perChar = randInt(18, 45);
    const reading = Math.min(chars * perChar, 5200);
    const jitter = randInt(400, 1600);

    let total = base + reading + jitter;
    total = Math.max(1600, Math.min(9500, total));
    await sleep(total);
  }

  async function humanDelayForOutboundText(outText) {
    const t = String(outText || '');
    const chars = t.length;

    const base = randInt(450, 1200);
    const perChar = randInt(22, 55);
    const typing = Math.min(chars * perChar, 6500);
    const jitter = randInt(250, 1200);

    let total = base + typing + jitter;
    total = Math.max(900, Math.min(12000, total));
    await sleep(total);
  }

  function sanitizeVeniceBodyForLog(body) {
    const clone = JSON.parse(JSON.stringify(body || {}));
    if (Array.isArray(clone.messages)) {
      clone.messages = clone.messages.map((m) => {
        const role = m?.role;
        const content = String(m?.content || '');

        if (role === 'system') {
          const sha = sha256Of(content);
          return { role, content: `[SYSTEM_PROMPT_OMITTED] chars=${content.length} sha256=${sha}` };
        }

        const MAX_LOG_CHARS = 200;
        if (content.length > MAX_LOG_CHARS) {
          const sha = sha256Of(content);
          return { role, content: `[TRUNCATED] first=${content.slice(0, MAX_LOG_CHARS)}... chars=${content.length} sha256=${sha}` };
        }

        return { role, content };
      });
    }
    return clone;
  }

  async function callVeniceChat({ apiKey, model, systemPromptRendered, userId }) {
    const url = 'https://api.venice.ai/api/v1/chat/completions';

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPromptRendered },
        { role: 'user', content: 'Responda exatamente no formato JSON especificado.' },
      ],
      temperature: 0.7,
      max_tokens: 700,
      response_format: { type: 'json_object' },
      user: userId || undefined,
      venice_parameters: {
        enable_web_search: 'off',
        include_venice_system_prompt: false,
        enable_web_citations: false,
        enable_web_scraping: false,
      },
      stream: false,
    };

    // aiLog('[AI][REQUEST]');
    // aiLog(JSON.stringify(sanitizeVeniceBodyForLog(body), null, 2));

    const r = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
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

  async function handleInboundBlock({
    wa_id,
    inboundPhoneNumberId,
    blocoText,
    mensagemAtualBloco,
    excludeWamids,

    // lead vem “injetado” pelo routes ao chamar (ver routes.js)
    lead,
  }) {
    const st = lead.getLead(wa_id);
    if (!st) return;

    const settings = global.botSettings || await db.getBotSettings();
    const veniceApiKey = (settings?.venice_api_key || '').trim();
    const veniceModel = (settings?.venice_model || '').trim();
    const systemPromptTpl = (settings?.system_prompt || '').trim();

    if (!veniceApiKey || !veniceModel || !systemPromptTpl) {
      await sendMessage(wa_id, 'Config incompleta no painel (venice key/model/prompt).', {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const bloco = String(blocoText || '').trim();
    const atual = String(mensagemAtualBloco || '').trim();

    await humanDelayForInboundText(bloco || atual);

    const facts = buildFactsJson(st, inboundPhoneNumberId);
    const historicoStr = lead.buildHistoryString(st, { excludeWamids });

    const msgParaPrompt = (bloco && atual && bloco !== atual)
      ? `BLOCO_USUARIO:\n${bloco}\n\nMENSAGEM_ATUAL_BLOCO:\n${atual}`
      : (atual || bloco);

    const rendered = renderSystemPrompt(systemPromptTpl, facts, historicoStr, msgParaPrompt);

    aiLog(`[AI][CTX][${wa_id}] phone_number_id=${inboundPhoneNumberId || ''}`);
    aiLog('[AI][MENSAGEM_ATUAL_BLOCO]');
    aiLog(atual || '');

    {
      const sha = sha256Of(rendered || '');
      aiLog(`[AI][SYSTEM_PROMPT_RENDERED] (omitted) chars=${(rendered || '').length} sha256=${sha}`);
    }

    const venice = await callVeniceChat({
      apiKey: veniceApiKey,
      model: veniceModel,
      systemPromptRendered: rendered,
      userId: wa_id,
    });

    if (!venice || venice.status < 200 || venice.status >= 300) {
      await sendMessage(wa_id, 'Tive um erro aqui. Manda de novo?', {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const content = venice?.data?.choices?.[0]?.message?.content || '';
    const parsed = safeParseAgentJson(content);

    aiLog(`[AI][RAW_CONTENT][${wa_id}]`);
    aiLog(content);

    if (!parsed.ok) {
      await sendMessage(wa_id, 'Não entendi direito. Me manda de novo?', {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });
      return;
    }

    const agent = parsed.data;
    const outMessages = (agent.messages || [])
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!outMessages.length) return;

    for (let i = 0; i < outMessages.length; i++) {
      const msg = outMessages[i];

      if (i > 0) await humanDelayForOutboundText(msg);

      const r = await sendMessage(wa_id, msg, {
        meta_phone_number_id: inboundPhoneNumberId || null,
      });

      if (r?.ok) {
        lead.pushHistory(wa_id, 'assistant', msg, {
          kind: 'text',
          wamid: r.wamid || '',
          phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
        });
      }
    }
  }

  return {
    // wrapper: routes/lead vão passar o lead aqui
    handleInboundBlock: async (payload) => {
      // payload vem do lead.flush -> aqui a gente injeta lead no routes.js
      // então esse wrapper não faz nada sozinho; é o routes que chama com lead
      return payload;
    },

    // expõe a função real pro routes (pra injetar lead)
    _handleInboundBlock: handleInboundBlock,
  };
}

module.exports = { createAiEngine };

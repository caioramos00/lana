const axios = require('axios');
const crypto = require('crypto');

function createAiEngine({ db, sendMessage, aiLog = () => { } } = {}) {
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

    // ===== LOG helpers (SEM depender de ENV) =====
    function truncateForLog(s, max) {
        const t = String(s || '');
        if (t.length <= max) return t;
        return t.slice(0, max) + `... (truncated chars=${t.length})`;
    }

    function logAiRequest({ wa_id, inboundPhoneNumberId, facts, historicoStr, msgParaPrompt, rendered, model }) {
        const histMax = 2500;
        const msgMax = 2500;
        const factsMax = 4000;

        const sha = sha256Of(rendered || '');

        aiLog(`[AI][REQUEST][${wa_id}] model=${model || ''} phone_number_id=${inboundPhoneNumberId || ''}`);
        aiLog(`[AI][REQUEST][${wa_id}] SYSTEM_PROMPT (omitted) chars=${(rendered || '').length} sha256=${sha}`);

        aiLog(`[AI][REQUEST][${wa_id}] FACTS_JSON:\n${truncateForLog(JSON.stringify(facts || {}, null, 2), factsMax)}`);
        aiLog(`[AI][REQUEST][${wa_id}] HISTORICO_PREVIEW:\n${truncateForLog(historicoStr || '', histMax)}`);
        aiLog(`[AI][REQUEST][${wa_id}] MENSAGEM_PARA_PROMPT:\n${truncateForLog(msgParaPrompt || '', msgMax)}`);

        aiLog(`[AI][REQUEST][${wa_id}] VENICE_MESSAGES:`);
        aiLog(JSON.stringify([
            { role: 'system', content: `[OMITTED] chars=${(rendered || '').length} sha256=${sha}` },
            { role: 'user', content: 'Responda exatamente no formato JSON especificado.' },
        ], null, 2));
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

    // ✅ função chamada pelo lead.flush (lead injetado pelo index.js)
    async function handleInboundBlock({
        wa_id,
        inboundPhoneNumberId,
        blocoText,
        mensagemAtualBloco,
        excludeWamids,
        lead,
    }) {
        aiLog(`[AI][INBOUND] wa_id: ${wa_id} - Inbound message received: "${blocoText.substring(0, 100)}... (total ${blocoText.length} chars)"`);
        if (!lead || typeof lead.getLead !== 'function') {
            aiLog('[AI][ERROR] leadStore não foi injetado no handleInboundBlock');
            return;
        }

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

        // ✅ mantém seus logs atuais
        aiLog(`[AI][CTX][${wa_id}] phone_number_id=${inboundPhoneNumberId || ''}`);
        aiLog(`[AI][SYSTEM_PROMPT_RENDERED] (omitted) chars=${(rendered || '').length} sha256=${sha256Of(rendered || '')}`);

        // ✅ NOVO: loga exatamente “o que foi pra IA”
        logAiRequest({
            wa_id,
            inboundPhoneNumberId,
            facts,
            historicoStr,
            msgParaPrompt,
            rendered,
            model: veniceModel,
        });

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

            if (!r?.ok) {
                aiLog(`[AI][SEND][${wa_id}] FAIL`, r);
            }

            if (r?.ok) {
                lead.pushHistory(wa_id, 'assistant', msg, {
                    kind: 'text',
                    wamid: r.wamid || '',
                    phone_number_id: r.phone_number_id || inboundPhoneNumberId || null,
                });
            }
        }
    }

    return { handleInboundBlock };
}

module.exports = { createAiEngine };

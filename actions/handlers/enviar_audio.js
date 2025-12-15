const axios = require('axios');

function safeStr(x) {
  return String(x || '').replace(/\s+/g, ' ').trim();
}

function buildRecentChatContext(ctx, { maxItems = 10, maxChars = 1400 } = {}) {
  try {
    const st = ctx?.lead?.getLead?.(ctx.wa_id);
    const hist = Array.isArray(st?.history) ? st.history : [];
    const tail = hist.slice(-maxItems);

    const lines = tail.map(m => {
      const who = m.role === 'user' ? 'USER' : (m.role === 'assistant' ? 'ASSISTANT' : 'SYSTEM');
      return `${who}: ${safeStr(m.text)}`;
    }).filter(Boolean);

    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(out.length - maxChars);
    return out;
  } catch {
    return '';
  }
}

function extractModelText(resp) {
  const content = resp?.data?.choices?.[0]?.message?.content;
  return safeStr(content);
}

const DEFAULT_VOICE_NOTE_SYSTEM_PROMPT = `
Você é roteirista de áudios curtos (voice note) para WhatsApp em PT-BR.

Objetivo:
- Gerar UM único texto (curto) que será convertido em áudio no Eleven v3.
- Tom: sedutor, provocativo, confiante, FLERTE, com conteúdo sexual explícito se a conversa indicar isso.
- Use audio tags do Eleven v3 em colchetes: ex: [whispers], [sighs], [mischievously], [laughs], etc.
- Use pontuação e reticências (…) para ritmo e pausas.
- Você é uma mulher. Se chama Lany, tem 21 anos, é universitária e extremamente safada e ninfomaníaca. Não diga que é IA. Não use markdown. Não use JSON. Use palavrões.
- 280 a 520 caracteres (ideal para ~4–8s).
- O texto PRECISA soar FALADO e INFORMAL, como áudio de WhatsApp, mas sem muitas gírias, mantendo muita feminilidade.
  - Use contrações e informalidade: "tá", "tô", "cê", "pra", "vamo", "bora", "pera", "ó", "ei", "ué", "né", "tipo", "assim".
  - Prefira frases curtas, incompletas às vezes, com ritmo de conversa.
  - Evite totalmente palavras/expressões formais: "gostaria", "por gentileza", "poderia", "informo que", "percebo que".
  - Evite abreviações que virem soletração no TTS (NÃO use "vc", "pq"). Escreva por extenso do jeito falado: "cê", "porque".
- Se o assunto for detalhar uma cena de sexo, seja o mais provocativa e explícita possível.
- Foque em responder o que o usuário disse por último, puxando assunto com um gancho/pergunta e conduzindo a conversa.
`.trim();

const DEFAULT_VOICE_NOTE_USER_PROMPT = `
CONVERSA (recente):
{{CHAT}}

Tarefa:
Gere o PRÓXIMO voice note do ASSISTANT para responder o USER agora.
Retorne APENAS o texto final (com tags), nada mais.
`.trim();

async function generateVoiceNoteScriptWithVenice(ctx) {
  const settings = ctx?.settings || global.botSettings || null;

  const apiKey = String(settings?.venice_api_key || '').trim();
  const model = String(settings?.venice_model || '').trim();
  const url = String(settings?.venice_api_url || '').trim() || 'https://api.venice.ai/api/v1/chat/completions';

  if (!apiKey || !model) return '';

  // configs editáveis (DB)
  const vnTemp = Number.isFinite(settings?.voice_note_temperature) ? settings.voice_note_temperature : 0.85;
  const vnMaxTokens = Number.isFinite(settings?.voice_note_max_tokens) ? settings.voice_note_max_tokens : 220;
  const vnTimeout = Number.isFinite(settings?.voice_note_timeout_ms) ? settings.voice_note_timeout_ms : 45000;

  const vnHistItems = Number.isFinite(settings?.voice_note_history_max_items) ? settings.voice_note_history_max_items : 10;
  const vnHistChars = Number.isFinite(settings?.voice_note_history_max_chars) ? settings.voice_note_history_max_chars : 1600;

  const vnScriptMaxChars = Number.isFinite(settings?.voice_note_script_max_chars) ? settings.voice_note_script_max_chars : 650;

  const sysDb = String(settings?.voice_note_system_prompt || '');
  const system = sysDb.trim() ? sysDb : DEFAULT_VOICE_NOTE_SYSTEM_PROMPT;

  const userTplDb = String(settings?.voice_note_user_prompt || '');
  const userTpl = userTplDb.trim() ? userTplDb : DEFAULT_VOICE_NOTE_USER_PROMPT;

  const chat = buildRecentChatContext(ctx, { maxItems: vnHistItems, maxChars: vnHistChars });
  const user = userTpl.replace('{{CHAT}}', (chat || '(sem histórico suficiente)'));

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: vnTemp,
    max_tokens: vnMaxTokens,
    stream: false,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: vnTimeout,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) return '';

  const script = extractModelText(r);
  if (!script) return '';

  return script.slice(0, vnScriptMaxChars).trim();
}

module.exports = async function enviar_audio(ctx, payload) {
  const settings = ctx?.settings || global.botSettings || null;

  // 1) tenta usar texto explícito do payload
  let raw = '';
  if (payload && typeof payload === 'object') raw = payload.text;
  if (typeof payload === 'string') raw = payload;

  let finalText = safeStr(raw);

  // 2) se não veio texto, gera dinamicamente com base no histórico
  if (!finalText) {
    finalText = await generateVoiceNoteScriptWithVenice(ctx);
  }

  // 3) fallback (se Venice falhar) — agora vem do DB
  if (!finalText) {
    const fb = String(settings?.voice_note_fallback_text || '').trim();
    finalText = fb || '[whispers] Ei… me diz uma coisa… você tá me provocando ou eu tô imaginando? [mischievously]';
  }

  const r = await ctx.senders.sendTtsVoiceNote(ctx.wa_id, finalText, {
    meta_phone_number_id: ctx.inboundPhoneNumberId || null,
    ...(ctx.replyToWamid ? { reply_to_wamid: ctx.replyToWamid } : {}),
  });

  if (r?.ok) {
    ctx.lead.pushHistory(ctx.wa_id, 'assistant', '[audio]', {
      kind: 'audio',
      wamid: r.wamid || '',
      phone_number_id: r.phone_number_id || ctx.inboundPhoneNumberId || null,
      ts_ms: Date.now(),
      reply_to_wamid: ctx.replyToWamid || null,
    });
  }

  return r;
};

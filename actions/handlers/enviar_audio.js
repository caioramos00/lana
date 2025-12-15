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

async function generateVoiceNoteScriptWithVenice(ctx) {
  const settings = ctx?.settings || global.botSettings || null;

  const apiKey = safeStr(settings?.venice_api_key);
  const model = safeStr(settings?.venice_model);
  const url = safeStr(settings?.venice_api_url) || 'https://api.venice.ai/api/v1/chat/completions';

  if (!apiKey || !model) return '';

  const chat = buildRecentChatContext(ctx, { maxItems: 10, maxChars: 1600 });

  // “Sexy/provocativa” = flerte + tensão + sussurros + pausas (sem explicitar sexo)
  // E com audio tags e pontuação (best practices v3)
  const system = `
Você é roteirista de áudios curtos (voice note) para WhatsApp em PT-BR.

Objetivo:
- Gerar UM único texto (curto) que será convertido em áudio no Eleven v3.
- Tom: sedutor, provocativo, confiante, FLERTE, com conteúdo sexual explícito se a conversa indicar isso.
- Use audio tags do Eleven v3 em colchetes: ex: [whispers], [sighs], [mischievously], [laughs], etc.
- Use pontuação e reticências (…) para ritmo e pausas.
- Você é uma mulher. Se chama Lany, tem 21 anos, é universitária e extremamente safada e ninfomaníaca. Não diga que é IA. Não use markdown. Não use JSON. Use palavrões.
- 280 a 520 caracteres (ideal para ~4–8s).
- Foque em responder o que o usuário disse por último, puxando o assunto e conduzindo a conversa.
`.trim();

  const user = `
CONVERSA (recente):
${chat || '(sem histórico suficiente)'}

Tarefa:
Gere o PRÓXIMO voice note do ASSISTANT para responder o USER agora.
Retorne APENAS o texto final (com tags), nada mais.
`.trim();

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.85,
    max_tokens: 220,
    stream: false,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 45000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) return '';

  const script = extractModelText(r);

  // hard guard: se vier gigante, corta
  if (!script) return '';
  return script.slice(0, 650).trim();
}

module.exports = async function enviar_audio(ctx, payload) {
  // 1) tenta usar texto explícito do payload
  let raw = '';
  if (payload && typeof payload === 'object') raw = payload.text;
  if (typeof payload === 'string') raw = payload;

  let finalText = safeStr(raw);

  // 2) se não veio texto, gera dinamicamente com base no histórico
  if (!finalText) {
    finalText = await generateVoiceNoteScriptWithVenice(ctx);
  }

  // 3) fallback (se Venice falhar)
  if (!finalText) {
    finalText = '[whispers] Ei… me diz uma coisa… você tá me provocando ou eu tô imaginando? [mischievously]';
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

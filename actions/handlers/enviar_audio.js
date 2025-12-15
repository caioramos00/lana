// enviar_audio.js
const axios = require('axios');

function safeStr(x) { return String(x || '').trim(); }

function takeLast(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(Math.max(0, arr.length - n));
}

function compact(s, max = 260) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim() + '…';
}

function buildRecentContext(ctx) {
  const waId = safeStr(ctx?.wa_id);
  const st = ctx?.lead?.getLead ? ctx.lead.getLead(waId) : null;
  const hist = Array.isArray(st?.history) ? st.history : [];

  // pega um bloco recente do histórico
  const lastHist = takeLast(hist, 14)
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && safeStr(m?.text))
    .map(m => {
      const who = m.role === 'user' ? 'USER' : 'ASSISTANT';
      return `${who}: ${compact(m.text, 220)}`;
    });

  // também tenta usar batch_items (quando existir) pra garantir “últimas mensagens do usuário”
  const batch = Array.isArray(ctx?.batch_items) ? ctx.batch_items : (Array.isArray(ctx?.batchItems) ? ctx.batchItems : []);
  const lastBatchUser = takeLast(batch, 6)
    .map(b => safeStr(b?.text))
    .filter(Boolean)
    .map(t => `USER: ${compact(t, 220)}`);

  const merged = [...lastHist, ...lastBatchUser]
    .slice(-18) // limite final
    .join('\n')
    .trim();

  // última msg do user (preferência: batch -> hist)
  const lastUserFromBatch = takeLast(batch, 6).map(b => safeStr(b?.text)).filter(Boolean).slice(-1)[0] || '';
  const lastUserFromHist = takeLast(hist.filter(m => m?.role === 'user'), 1).map(m => safeStr(m?.text))[0] || '';
  const lastUser = lastUserFromBatch || lastUserFromHist || '';

  return { mergedContext: merged, lastUser };
}

function clampPromptLen(t, { min = 260, max = 620 } = {}) {
  let s = safeStr(t);

  // garante um tamanho mínimo (v3 alpha tende a ficar melhor >250 chars) :contentReference[oaicite:2]{index=2}
  if (s.length < min) {
    s = (s + ' ' + 'Vem cá… me conta rapidinho o que você quer AGORA, sem enrolar.').trim();
  }

  if (s.length > max) {
    // corta sem destruir a frase
    s = s.slice(0, max);
    const cut = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
    if (cut > 120) s = s.slice(0, cut + 1);
    s = s.trim();
  }

  return s;
}

async function generateTtsTextWithVenice({ settings, contextText, lastUser, hint }) {
  const veniceApiKey = safeStr(settings?.venice_api_key);
  const veniceModel = safeStr(settings?.venice_model);
  const veniceUrl = safeStr(settings?.venice_api_url) || 'https://api.venice.ai/api/v1/chat/completions';

  if (!veniceApiKey || !veniceModel) return null;

  // System prompt focado em:
  // - Tom “sexy/provocativo” (sem explicitão)
  // - Audio tags do Eleven v3 em colchetes (auditivas) :contentReference[oaicite:3]{index=3}
  // - Pontuação/pausas/ênfases :contentReference[oaicite:4]{index=4}
  // - Tamanho >= 250 chars :contentReference[oaicite:5]{index=5}
  const sys = `
Você escreve um TEXTO curto para virar ÁUDIO (WhatsApp voice note) em PT-BR usando Eleven v3 (alpha).

OBJETIVO:
Responder a última mensagem do usuário com um tom íntimo, confiante, “sexy” e provocativo — mas SEM ser explícito/pornográfico.
Nada de conteúdo sexual explícito, nada envolvendo menores, nada de termos gráficos.

REGRAS DO TEXTO (importante para Eleven v3):
- Entregue entre 280 e 520 caracteres (ideal: 1 parágrafo curto).
- Use de 1 a 3 AUDIO TAGS EM COLCHETES, sempre auditivas, ex: [whispers], [sighs], [exhales], [laughs softly], [mischievously].
- Use pontuação para ritmo: "..." para pausa curta e frases curtas.
- Não use múltiplos speakers. Não use listas. Não use markdown.
- Não diga que você é IA. Não cite “prompt”, “modelo”, “Eleven”, “Venice”.
- Retorne SOMENTE o texto final do áudio.

CONTEXTO RECENTE (conversa):
${contextText || '(sem contexto)'}

ÚLTIMA MENSAGEM DO USUÁRIO:
${lastUser || '(vazio)'}

INTENÇÃO/PISTA (se existir):
${hint || '(nenhuma)'}
`.trim();

  const body = {
    model: veniceModel,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: 'Escreva agora o texto do áudio.' },
    ],
    temperature: 0.9,
    max_tokens: 220,
    stream: false,
  };

  const r = await axios.post(veniceUrl, body, {
    headers: {
      Authorization: `Bearer ${veniceApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) return null;

  const out = safeStr(r.data?.choices?.[0]?.message?.content);
  return out || null;
}

module.exports = async function enviar_audio(ctx, payload) {
  // ✅ aceita texto manual (quando você quiser forçar)
  // - se payload vier vazio/sem texto => gera dinâmico com base na conversa
  const raw =
    (payload && typeof payload === 'object' && payload.text != null) ? String(payload.text) :
    (typeof payload === 'string' ? String(payload) : '');

  const hint = safeStr(
    (payload && typeof payload === 'object' && payload.hint) ? payload.hint :
    ''
  );

  const wantsAuto =
    !safeStr(raw) ||
    safeStr(raw).toLowerCase() === '__auto__' ||
    safeStr(raw).toLowerCase() === 'auto';

  const fallback = 'Posso te explicar rapidinho por áudio… me diz só uma coisa: o que você quer agora?';

  let finalText = safeStr(raw) || fallback;

  try {
    if (wantsAuto) {
      const settings = ctx?.settings || global.botSettings || (ctx?.db?.getBotSettings ? await ctx.db.getBotSettings() : null);

      const { mergedContext, lastUser } = buildRecentContext(ctx);

      const dyn = await generateTtsTextWithVenice({
        settings,
        contextText: mergedContext,
        lastUser,
        hint,
      });

      if (dyn) finalText = dyn;
    }
  } catch {
    // silêncio: cai no fallback
  }

  finalText = clampPromptLen(finalText, { min: 260, max: 620 });

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

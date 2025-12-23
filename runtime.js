const crypto = require('crypto');

function sha256Of(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
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

function normalizeProvider(x) {
  const p = String(x || '').trim().toLowerCase();
  return (p === 'openai' || p === 'venice' || p === 'grok') ? p : 'venice';
}

function normalizeReasoningEffort(x) {
  const v = String(x || '').trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
}

function readAiRuntimeConfig(settings) {
  const s = settings || {};

  const ai_provider = normalizeProvider(s.ai_provider);

  const venice_api_url =
    (String(s.venice_api_url || '').trim() || 'https://api.venice.ai/api/v1/chat/completions');

  const venice_temperature = clampNum(toNumberOrNull(s.venice_temperature), { min: 0, max: 2 });
  const temperature = (venice_temperature === null) ? 0.7 : venice_temperature;

  const venice_max_tokens = clampInt(toNumberOrNull(s.venice_max_tokens), { min: 16, max: 4096 });
  const max_tokens = (venice_max_tokens === null) ? 700 : venice_max_tokens;

  const venice_timeout_ms = clampInt(toNumberOrNull(s.venice_timeout_ms), { min: 1000, max: 180000 });
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

  const openai_api_url =
    (String(s.openai_api_url || '').trim() || 'https://api.openai.com/v1/responses');

  const openai_max_output_tokens =
    clampInt(toNumberOrNull(s.openai_max_output_tokens), { min: 16, max: 32768 });

  const openai_reasoning_effort = normalizeReasoningEffort(s.openai_reasoning_effort);

  const grok_api_url =
    (String(s.grok_api_url || '').trim() || 'https://api.x.ai/v1/chat/completions');

  const grok_temperature = clampNum(toNumberOrNull(s.grok_temperature), { min: 0, max: 2 });
  const grok_max_tokens = clampInt(toNumberOrNull(s.grok_max_tokens), { min: 16, max: 4096 });

  const grokTemp = (grok_temperature === null) ? 0.7 : grok_temperature;
  const grokMaxTokens = (grok_max_tokens === null) ? 700 : grok_max_tokens;

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

  const autoAudioEnabled = (s.auto_audio_enabled === undefined || s.auto_audio_enabled === null) ? false : !!s.auto_audio_enabled;
  const autoAudioAfterMsgs = clampInt(toNumberOrNull(s.auto_audio_after_msgs), { min: 5, max: 50 }) ?? 12;

  return {
    ai_provider,
    venice_api_url,
    temperature,
    max_tokens,
    timeoutMs,
    stream,
    venice_parameters,
    userMessage,
    openai_api_url,
    openai_max_output_tokens,
    openai_reasoning_effort,
    grok_api_url,
    grok_temperature: grokTemp,
    grok_max_tokens: grokMaxTokens,
    max_out_messages,
    msg_config_incomplete,
    msg_generic_error,
    msg_parse_error,
    inboundDelay,
    outboundDelay,
    salesCooldownMs,
    salesCooldownMinUserMsgs,
    autoAudioEnabled,
    autoAudioAfterMsgs,
  };
}

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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

function truncateForLog(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return t.slice(0, max) + `... (truncated chars=${t.length})`;
}

function logAiRequest({ provider, wa_id, inboundPhoneNumberId, facts, historicoStr, msgParaPrompt, rendered, model, batchItems, userMessage, endpoint, aiLog = () => { } }) {
  const histMax = 2500;
  const msgMax = 2500;
  const factsMax = 4000;

  const sha = sha256Of(rendered || '');

  aiLog(`[AI][REQUEST][${wa_id}] provider=${provider} model=${model || ''} phone_number_id=${inboundPhoneNumberId || ''}`);
  if (endpoint) aiLog(`[AI][REQUEST][${wa_id}] endpoint=${endpoint}`);
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

  aiLog(`[AI][REQUEST][${wa_id}] AI_MESSAGES_META:`);
  aiLog(JSON.stringify([
    { role: 'system', content: `[OMITTED] chars=${(rendered || '').length} sha256=${sha}` },
    { role: 'user', content: userMessage || 'Responda exatamente no formato JSON especificado.' },
  ], null, 2));
}

module.exports = {
  readAiRuntimeConfig,
  humanDelayForInboundText,
  humanDelayForOutboundText,
  logAiRequest,
};

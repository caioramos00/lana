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

function normalizeVoiceNoteProvider(x) {
  const p = String(x || '').trim().toLowerCase();
  if (p === 'inherit' || p === 'venice' || p === 'openai' || p === 'grok') return p;
  return 'inherit';
}

function readVoiceNoteRuntimeConfig(settings, mainCfg) {
  const s = settings || {};
  const vnProv = normalizeVoiceNoteProvider(s.voice_note_ai_provider);
  const provider = (vnProv === 'inherit') ? mainCfg.ai_provider : vnProv;

  const model =
    (provider === 'venice')
      ? (String(s.voice_note_venice_model || '').trim() || String(s.venice_model || '').trim())
      : (provider === 'openai')
        ? (String(s.voice_note_openai_model || '').trim() || String(s.openai_model || '').trim())
        : (String(s.voice_note_grok_model || '').trim() || String(s.grok_model || '').trim());

  const temperature = clampNum(toNumberOrNull(s.voice_note_temperature), { min: 0, max: 2 }) ?? 0.85;
  const maxTokens = clampInt(toNumberOrNull(s.voice_note_max_tokens), { min: 16, max: 4096 }) ?? 220;
  const timeoutMs = clampInt(toNumberOrNull(s.voice_note_timeout_ms), { min: 1000, max: 180000 }) ?? 45000;

  const histMaxChars = clampInt(toNumberOrNull(s.voice_note_history_max_chars), { min: 200, max: 8000 }) ?? 1600;
  const scriptMaxChars = clampInt(toNumberOrNull(s.voice_note_script_max_chars), { min: 200, max: 4000 }) ?? 650;

  const systemPrompt = String(s.voice_note_system_prompt || '').trim();
  const userTpl = String(s.voice_note_user_prompt || '').trim();

  return {
    provider,
    model,
    temperature,
    maxTokens,
    timeoutMs,
    histMaxChars,
    scriptMaxChars,
    systemPrompt,
    userTpl,
  };
}

function renderVoiceNotePrompt({ systemPrompt, userTpl, chatStr }) {
  const tpl = userTpl || `HISTÓRICO:\n{{CHAT}}\n\nEscreva um roteiro curto e natural de áudio, no mesmo tom da conversa. Sem markdown.`;

  const chat = String(chatStr || '').trim();
  const u = tpl.replace(/\{\{CHAT\}\}/g, chat);
  const s = (systemPrompt || '').replace(/\{\{CHAT\}\}/g, chat);

  return { system: s, user: u };
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

function hardCut(s, maxChars) {
  const t = String(s || '').trim();
  if (!maxChars || t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim();
}

module.exports = {
  leadAskedForAudio,
  readVoiceNoteRuntimeConfig,
  renderVoiceNotePrompt,
  makeAutoShortScriptFromText,
  makeFreeScriptFromOutItems,
  hardCut,
};

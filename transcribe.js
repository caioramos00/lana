const axios = require('axios');
const fs = require('fs');

let FormData = null;
try { FormData = require('form-data'); } catch { /* ok */ }

/**
 * Transcreve áudio via OpenAI (Whisper).
 * Tudo vem do settings (DB) e aplica sem restart.
 */
async function transcribeAudioOpenAI({ filePath, settings }) {
  const apiKey = String(settings?.openai_api_key || '').trim();
  if (!apiKey) return { ok: false, reason: 'missing-openai-api-key' };
  if (!FormData) return { ok: false, reason: 'missing-form-data' };

  const enabled =
    (settings?.openai_transcribe_enabled === undefined || settings?.openai_transcribe_enabled === null)
      ? true
      : !!settings.openai_transcribe_enabled;

  if (!enabled) return { ok: false, reason: 'transcribe-disabled' };

  const model = String(settings?.openai_transcribe_model || '').trim() || 'whisper-1';
  const language = String(settings?.openai_transcribe_language || '').trim(); // '' => autodetect (não envia)
  const prompt = String(settings?.openai_transcribe_prompt || '').trim();     // '' => não envia

  const timeoutMsRaw = Number(settings?.openai_transcribe_timeout_ms);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 60000;

  const url = 'https://api.openai.com/v1/audio/transcriptions';

  const form = new FormData();
  form.append('model', model);
  form.append('file', fs.createReadStream(filePath));
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  form.append('response_format', 'json');

  const r = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    const body = r.data ? JSON.stringify(r.data).slice(0, 800) : '';
    return { ok: false, reason: `openai-http-${r.status}`, body };
  }

  const text = String(r.data?.text || '').trim();
  if (!text) return { ok: false, reason: 'empty-transcript' };

  return { ok: true, text, model };
}

module.exports = { transcribeAudioOpenAI };

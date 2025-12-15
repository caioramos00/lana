// senders.js (META-only + SSE publish)
// - NÃO depende de ./utils.js, ./optout.js, ./stateManager.js
// - Guarda em memória o phone_number_id do inbound por lead (pra responder sempre pelo mesmo)
// - Resolve credenciais via bot_meta_numbers (token por número) e fallback em bot_settings.graph_api_access_token
// - Publica no SSE via publishMessage
//
// + Definitivo: gera TTS (ElevenLabs) em OGG/Opus e envia como áudio (voice note)

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const db = require('./db');
const { publishMessage } = require('./stream/events-bus');

// Dependência recomendada p/ multipart/form-data no Node + axios
let FormData = null;
try { FormData = require('form-data'); } catch { /* ok */ }

// wa_id -> { phone_number_id, ts }
const inboundMetaMap = new Map();

// limpeza leve (não é “histórico”, é só pra não acumular lixo)
const INBOUND_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of inboundMetaMap.entries()) {
    if (!v?.ts || (t - v.ts) > INBOUND_MAP_TTL_MS) inboundMetaMap.delete(k);
  }
}, 6 * 60 * 60 * 1000);

function patchOpusHeadInputSampleRate(filePath, targetHz = 24000) {
  const buf = fs.readFileSync(filePath);
  const idx = buf.indexOf(Buffer.from('OpusHead'));
  if (idx < 0) return false;

  // OpusHead(8) + version(1) + channels(1) + preskip(2) = 12 bytes
  const rateOff = idx + 12;
  if (rateOff + 4 > buf.length) return false;

  buf.writeUInt32LE(Number(targetHz) >>> 0, rateOff);
  fs.writeFileSync(filePath, buf);
  return true;
}

function rememberInboundMetaPhoneNumberId(wa_id, phone_number_id) {
  const key = String(wa_id || '').trim();
  const pnid = String(phone_number_id || '').trim();
  if (!key || !pnid) return;
  inboundMetaMap.set(key, { phone_number_id: pnid, ts: Date.now() });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  const a = Number(min || 0);
  const b = Number(max || 0);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

async function delayBetween(range) {
  if (!range) return;
  const [minMs, maxMs] = Array.isArray(range) ? range : [0, 0];
  const ms = randInt(minMs, maxMs);
  if (ms > 0) await sleep(ms);
}

async function getSettings() {
  // prioridade: global.botSettings (bootstrap do index.js)
  if (global.botSettings) return global.botSettings;
  return await db.getBotSettings();
}

async function resolveMetaCredentialsForContato(wa_id, settings, opts = {}) {
  const key = String(wa_id || '').trim();

  // 1) obrigatório pelo requisito: se tiver o inbound phone_number_id, usar ele
  const fromOpts = String(opts.meta_phone_number_id || '').trim() || null;
  const fromMap = inboundMetaMap.get(key)?.phone_number_id || null;

  const candidatePhoneNumberId = fromOpts || fromMap || null;

  // tenta credenciais por phone_number_id (tabela bot_meta_numbers)
  if (candidatePhoneNumberId) {
    const row = await db.getMetaNumberByPhoneNumberId(candidatePhoneNumberId);
    if (row && row.active !== false) {
      return {
        phoneNumberId: row.phone_number_id,
        token: row.access_token,
      };
    }
  }

  // fallback: primeiro número ativo cadastrado
  const def = await db.getDefaultMetaNumber();
  if (def && def.active !== false) {
    return {
      phoneNumberId: def.phone_number_id,
      token: def.access_token,
    };
  }

  // último fallback: token global (se você insistir em usar)
  return {
    phoneNumberId: candidatePhoneNumberId,
    token: (settings?.graph_api_access_token || '').trim() || null,
  };
}

async function metaPostMessage({ phoneNumberId, token, version, payload }) {
  const apiVersion = version || 'v24.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const r = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    const body = r.data ? JSON.stringify(r.data).slice(0, 800) : '';
    throw new Error(`Meta HTTP ${r.status} ${body}`);
  }

  return r.data || {};
}

// ======= MEDIA UPLOAD (local file -> media id) =======
function guessAudioMime(filePath) {
  const ext = String(path.extname(filePath || '')).toLowerCase();

  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.amr') return 'audio/amr';

  return 'application/octet-stream';
}

async function metaUploadMediaFromPath({ phoneNumberId, token, version, filePath, mimeType }) {
  if (!FormData) {
    throw new Error('Dependência ausente: instale "form-data" (npm i form-data)');
  }

  const abs = String(filePath || '');
  if (!abs || !fs.existsSync(abs)) {
    throw new Error(`Arquivo não encontrado: ${abs}`);
  }

  const apiVersion = version || 'v24.0';
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');

  const mt = String(mimeType || '').trim() || guessAudioMime(abs);
  form.append('type', mt);

  form.append('file', fs.createReadStream(abs), {
    filename: path.basename(abs),
    contentType: mt,
  });

  const r = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    timeout: 30000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    const body = r.data ? JSON.stringify(r.data).slice(0, 1200) : '';
    throw new Error(`Meta HTTP ${r.status} ${body}`);
  }

  const id = r.data?.id ? String(r.data.id) : '';
  if (!id) throw new Error(`Upload ok mas sem media id no retorno: ${JSON.stringify(r.data).slice(0, 500)}`);

  return { id, raw: r.data };
}

// ======= SEND TEXT =======
async function sendMessage(contato, texto, opts = {}) {
  const to = String(contato || '').trim();
  const text = String(texto || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };
  if (!text) return { ok: false, reason: 'empty-text' };

  try {
    const settings = await getSettings();
    const { phoneNumberId, token } = await resolveMetaCredentialsForContato(to, settings, opts);

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    const replyTo = String(opts.reply_to_wamid || opts.replyToWamid || '').trim() || null;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };

    if (replyTo) {
      payload.context = { message_id: replyTo };
    }

    const data = await metaPostMessage({
      phoneNumberId,
      token,
      version: settings?.meta_api_version || 'v24.0',
      payload,
    });

    try {
      publishMessage({
        dir: 'out',
        wa_id: to,
        wamid: (data?.messages && data.messages[0]?.id) ? String(data.messages[0].id) : '',
        kind: 'text',
        text,
        ts: Date.now(),
      });
    } catch { }

    return { ok: true, provider: 'meta', phone_number_id: phoneNumberId, wamid: data?.messages?.[0]?.id || '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ======= SEND IMAGE (já existia) =======
async function sendImage(contato, urlOrItems, captionOrOpts, opts = {}) {
  if (typeof captionOrOpts === 'object' && captionOrOpts) {
    opts = captionOrOpts;
    captionOrOpts = undefined;
  }

  const to = String(contato || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };

  const isArray = Array.isArray(urlOrItems);
  const items = isArray
    ? urlOrItems
    : [{ url: urlOrItems, caption: captionOrOpts }];

  const delayBetweenMs = opts.delayBetweenMs || [250, 900];

  try {
    const settings = await getSettings();
    const { phoneNumberId, token } = await resolveMetaCredentialsForContato(to, settings, opts);

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const url = String(items[i]?.url || '').trim();
      const caption = String(items[i]?.caption || '').trim();

      if (!/^https?:\/\//i.test(url)) {
        results.push({ ok: false, reason: 'invalid-url', url });
      } else {
        const payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: caption ? { link: url, caption } : { link: url },
        };

        try {
          const data = await metaPostMessage({
            phoneNumberId,
            token,
            version: settings?.meta_api_version || 'v24.0',
            payload,
          });

          try {
            publishMessage({
              dir: 'out',
              wa_id: to,
              wamid: (data?.messages && data.messages[0]?.id) ? String(data.messages[0].id) : '',
              kind: 'image',
              text: caption || '',
              media: { type: 'image', link: url },
              ts: Date.now(),
            });
          } catch { }

          results.push({ ok: true, wamid: data?.messages?.[0]?.id || '' });
        } catch (e) {
          results.push({ ok: false, reason: 'meta-send-failed', error: e?.message || String(e) });
        }
      }

      if (i < items.length - 1) {
        await delayBetween(delayBetweenMs);
      }
    }

    const okAll = results.every((r) => r?.ok);
    return isArray ? { ok: okAll, results, provider: 'meta', phone_number_id: phoneNumberId } : results[0];
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ======= SEND AUDIO (definitivo) =======
async function sendAudioByMediaId(contato, mediaId, opts = {}) {
  const to = String(contato || '').trim();
  const id = String(mediaId || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };
  if (!id) return { ok: false, reason: 'missing-media-id' };

  try {
    const settings = await getSettings();
    const { phoneNumberId, token } = await resolveMetaCredentialsForContato(to, settings, opts);

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    const replyTo = String(opts.reply_to_wamid || opts.replyToWamid || '').trim() || null;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: { id },
    };

    if (replyTo) payload.context = { message_id: replyTo };

    const data = await metaPostMessage({
      phoneNumberId,
      token,
      version: settings?.meta_api_version || 'v24.0',
      payload,
    });

    try {
      publishMessage({
        dir: 'out',
        wa_id: to,
        wamid: (data?.messages && data.messages[0]?.id) ? String(data.messages[0].id) : '',
        kind: 'audio',
        text: '',
        media: { type: 'audio', id },
        ts: Date.now(),
      });
    } catch { }

    return { ok: true, provider: 'meta', phone_number_id: phoneNumberId, wamid: data?.messages?.[0]?.id || '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendAudioFromPath(contato, filePath, opts = {}) {
  const to = String(contato || '').trim();
  const fp = String(filePath || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };
  if (!fp) return { ok: false, reason: 'missing-filepath' };

  try {
    const settings = await getSettings();
    const { phoneNumberId, token } = await resolveMetaCredentialsForContato(to, settings, opts);

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    const mimeType = String(opts.mimeType || '').trim() || guessAudioMime(fp);

    const up = await metaUploadMediaFromPath({
      phoneNumberId,
      token,
      version: settings?.meta_api_version || 'v24.0',
      filePath: fp,
      mimeType,
    });

    const r = await sendAudioByMediaId(to, up.id, opts);
    return { ...r, uploaded_media_id: up.id, mimeType, filePath: fp };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), filePath: fp };
  }
}

function numOpt(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function resolveElevenConfig(settings, opts = {}) {
  // ✅ sem process.env
  const apiKey =
    String(opts.eleven_api_key || '').trim() ||
    String(settings?.elevenlabs_api_key || '').trim() ||
    null;

  const voiceId =
    String(opts.eleven_voice_id || '').trim() ||
    String(settings?.eleven_voice_id || '').trim() ||
    null;

  const modelId =
    String(opts.eleven_model_id || '').trim() ||
    String(settings?.eleven_model_id || '').trim() ||
    'eleven_v3';

  const outputFormat =
    String(opts.eleven_output_format || '').trim() ||
    String(settings?.eleven_output_format || '').trim() ||
    'ogg_opus';

  // ✅ voice settings: opts sobrescreve; senão usa DB
  const stability =
    (opts.stability != null ? Number(opts.stability) : numOpt(settings?.eleven_stability));
  const similarity_boost =
    (opts.similarity_boost != null ? Number(opts.similarity_boost) : numOpt(settings?.eleven_similarity_boost));
  const style =
    (opts.style != null ? Number(opts.style) : numOpt(settings?.eleven_style));
  const use_speaker_boost =
    (opts.use_speaker_boost != null ? !!opts.use_speaker_boost : (settings?.eleven_use_speaker_boost != null ? !!settings.eleven_use_speaker_boost : null));

  return { apiKey, voiceId, modelId, outputFormat, stability, similarity_boost, style, use_speaker_boost };
}

async function elevenTtsToTempFile(text, settings, opts = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('TTS: text vazio');

  const { apiKey, voiceId, modelId, outputFormat, stability, similarity_boost, style, use_speaker_boost } =
    resolveElevenConfig(settings, opts);

  if (!apiKey) throw new Error('TTS: faltou elevenlabs_api_key (painel/db)');
  if (!voiceId) throw new Error('TTS: faltou eleven_voice_id (painel/db)');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  const body = {
    text: t,
    model_id: modelId,
  };

  const voice_settings = {};
  if (stability != null && Number.isFinite(stability)) voice_settings.stability = stability;
  if (similarity_boost != null && Number.isFinite(similarity_boost)) voice_settings.similarity_boost = similarity_boost;
  if (style != null && Number.isFinite(style)) voice_settings.style = style;
  if (use_speaker_boost != null) voice_settings.use_speaker_boost = !!use_speaker_boost;
  if (Object.keys(voice_settings).length) body.voice_settings = voice_settings;

  const r = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      // header padrão da ElevenLabs
      'xi-api-key': apiKey,
      // dica: alguns setups respeitam Accept, mas o output_format já manda o formato
      'Accept': 'audio/ogg',
    },
    responseType: 'arraybuffer',
    timeout: 60000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    let msg = '';
    try { msg = Buffer.from(r.data || []).toString('utf8'); } catch { }
    throw new Error(`ElevenLabs HTTP ${r.status} ${msg.slice(0, 800)}`);
  }

  const buf = Buffer.from(r.data);

  const name = `tts_${Date.now()}_${crypto.randomUUID()}.opus`;

  const outPath = path.join(os.tmpdir(), name);

  fs.writeFileSync(outPath, buf);
  patchOpusHeadInputSampleRate(outPath, 24000);
  return outPath;
}

async function sendTtsVoiceNote(contato, text, opts = {}) {
  const to = String(contato || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };

  let tmpFile = null;

  try {
    const settings = await getSettings();
    const { phoneNumberId, token } = await resolveMetaCredentialsForContato(to, settings, opts);

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    // 1) gera OGG/Opus em /tmp
    tmpFile = await elevenTtsToTempFile(text, settings, opts);

    // 2) upload na Meta (tipo certo)
    const up = await metaUploadMediaFromPath({
      phoneNumberId,
      token,
      version: settings?.meta_api_version || 'v24.0',
      filePath: tmpFile,
      mimeType: 'audio/ogg; codecs=opus',
    });

    // 3) envia audio referenciando media id
    const rSend = await sendAudioByMediaId(to, up.id, opts);

    return {
      ...rSend,
      tts: { provider: 'elevenlabs', voice_id: resolveElevenConfig(settings, opts).voiceId, model_id: resolveElevenConfig(settings, opts).modelId, output_format: resolveElevenConfig(settings, opts).outputFormat },
      uploaded_media_id: up.id,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  rememberInboundMetaPhoneNumberId,
  resolveMetaCredentialsForContato,
  sendMessage,
  sendImage,

  // áudio
  sendAudioByMediaId,
  sendAudioFromPath,

  // definitivo: TTS -> voice note
  sendTtsVoiceNote,
};

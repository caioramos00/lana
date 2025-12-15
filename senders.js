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

const OGG_CRC_TABLE = (() => {
  const poly = 0x04c11db7 >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = ((r & 0x80000000) ? ((r << 1) ^ poly) : (r << 1)) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc32(pageBuf) {
  // CRC do OGG é calculado com o campo CRC zerado (offset 22..25)
  const tmp = Buffer.from(pageBuf);
  if (tmp.length >= 26) tmp.writeUInt32LE(0, 22);
  let crc = 0 >>> 0;
  for (let i = 0; i < tmp.length; i++) {
    const idx = ((crc >>> 24) ^ tmp[i]) & 0xff;
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[idx]) >>> 0;
  }
  return crc >>> 0;
}

function analyzeOggOpusFile(filePath) {
  const abs = String(filePath || '');
  const buf = fs.readFileSync(abs);
  const size = buf.length;

  const out = {
    filePath: abs,
    fileName: path.basename(abs),
    sizeBytes: size,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    headHex: buf.subarray(0, 32).toString('hex'),
    isOgg: buf.subarray(0, 4).toString('ascii') === 'OggS',
    opusHead: null,
    opusTags: null,
    ogg: {
      pages: 0,
      lastGranulePos: null,
      durationSec: null,
      bitrateBps: null,
      crcOkPages: 0,
      crcBadPages: 0,
      firstBadCrc: null,
    },
  };

  if (!out.isOgg) return out;

  let preSkip = 0;
  let lastGranule = null;

  let off = 0;
  while (off + 27 <= buf.length) {
    if (buf.subarray(off, off + 4).toString('ascii') !== 'OggS') break;

    const headerType = buf.readUInt8(off + 5);
    const granulePos = buf.readBigUInt64LE(off + 6);
    const pageSegments = buf.readUInt8(off + 26);

    const segTableOff = off + 27;
    const segTableEnd = segTableOff + pageSegments;
    if (segTableEnd > buf.length) break;

    let dataLen = 0;
    for (let i = 0; i < pageSegments; i++) dataLen += buf.readUInt8(segTableOff + i);

    const dataOff = segTableEnd;
    const dataEnd = dataOff + dataLen;
    if (dataEnd > buf.length) break;

    out.ogg.pages += 1;

    // CRC check
    try {
      const stored = buf.readUInt32LE(off + 22) >>> 0;
      const computed = oggCrc32(buf.subarray(off, dataEnd)) >>> 0;
      if (stored === computed) out.ogg.crcOkPages += 1;
      else {
        out.ogg.crcBadPages += 1;
        if (!out.ogg.firstBadCrc) {
          out.ogg.firstBadCrc = { page: out.ogg.pages, stored, computed };
        }
      }
    } catch { /* ignore */ }

    if (headerType & 0x04) lastGranule = granulePos;
    else lastGranule = granulePos;

    const pageData = buf.subarray(dataOff, dataEnd);

    if (!out.opusHead) {
      const idx = pageData.indexOf(Buffer.from('OpusHead'));
      if (idx >= 0 && idx + 19 <= pageData.length) {
        const p = pageData.subarray(idx, idx + 19);
        const version = p.readUInt8(8);
        const channels = p.readUInt8(9);
        preSkip = p.readUInt16LE(10);
        const inputSampleRate = p.readUInt32LE(12);
        const outputGain = p.readInt16LE(16);
        const channelMappingFamily = p.readUInt8(18);

        out.opusHead = { version, channels, preSkip, inputSampleRate, outputGain, channelMappingFamily };
      }
    }

    if (!out.opusTags) {
      const tidx = pageData.indexOf(Buffer.from('OpusTags'));
      if (tidx >= 0 && tidx + 12 <= pageData.length) {
        const base = tidx + 8;
        if (base + 4 <= pageData.length) {
          const vendorLen = pageData.readUInt32LE(base);
          const vStart = base + 4;
          const vEnd = vStart + vendorLen;
          if (vEnd <= pageData.length) {
            const vendor = pageData.subarray(vStart, vEnd).toString('utf8');
            out.opusTags = { vendorLen, vendor };
          }
        }
      }
    }

    off = dataEnd;
  }

  out.ogg.lastGranulePos = (lastGranule != null) ? String(lastGranule) : null;

  if (lastGranule != null) {
    const g = lastGranule;
    const ps = BigInt(preSkip || 0);
    const samples = (g > ps) ? (g - ps) : g;
    const durationSec = Number(samples) / 48000; // OggOpus timeline é 48k
    out.ogg.durationSec = Number.isFinite(durationSec) ? durationSec : null;

    if (out.ogg.durationSec && out.ogg.durationSec > 0) {
      out.ogg.bitrateBps = Math.round((size * 8) / out.ogg.durationSec);
    }
  }

  return out;
}

function logAudioInfo(label, filePath, extra = {}) {
  try {
    const info = analyzeOggOpusFile(filePath);
    console.log(`[AUDIO][INFO][${label}]`, JSON.stringify({ ...info, ...extra }));
  } catch (e) {
    console.log(`[AUDIO][INFO][${label}] failed:`, e?.message || String(e));
  }
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

async function metaUploadMediaFromPath({ phoneNumberId, token, version, filePath, mimeType, filename }) {
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

  // IMPORTANTE: pra voice note, use "audio/ogg" (sem "; codecs=opus")
  const mt = String(mimeType || '').trim() || guessAudioMime(abs);
  form.append('type', mt);

  const upName = String(filename || '').trim() || path.basename(abs);

  form.append('file', fs.createReadStream(abs), {
    filename: upName,
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

  return { id, raw: r.data, upload: { mimeType: mt, filename: upName } };
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

    const audioObj = { id };

    // ✅ tenta forçar “voice note / ptt” (se a API ignorar, não quebra)
    if (opts.voice_note === true || opts.voice === true || opts.ptt === true) {
      audioObj.voice = true;
    }

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: audioObj,
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
        media: { type: 'audio', id, voice: !!audioObj.voice },
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

  // FORÇADO: sempre esse formato
  const outputFormat = 'opus_48000_32';

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
      'xi-api-key': apiKey,
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
  const name = `tts_${Date.now()}_${crypto.randomUUID()}.ogg`;
  const outPath = path.join(os.tmpdir(), name);

  fs.writeFileSync(outPath, buf);

  // LOGS IMPORTANTES
  console.log('[AUDIO][ELEVEN][HTTP]', JSON.stringify({
    status: r.status,
    contentType: String(r.headers?.['content-type'] || ''),
    contentLength: String(r.headers?.['content-length'] || ''),
    outputFormat,
  }));

  logAudioInfo('elevenlabs-file', outPath, { source: 'elevenlabs', outputFormat });

  return outPath;
}

async function sendTtsVoiceNote(contato, text, opts = {}) {
  const to = String(contato || '').trim();
  if (!to) return { ok: false, reason: 'missing-to' };

  let tmpFile = null;

  function findResponseOpusPath() {
    const mainDir = (() => {
      try {
        const mf = require.main?.filename ? String(require.main.filename) : '';
        return mf ? path.dirname(mf) : null;
      } catch { return null; }
    })();

    const candidates = [
      opts.response_opus_path ? String(opts.response_opus_path) : null,
      path.join(process.cwd(), 'response.opus'),
      mainDir ? path.join(mainDir, 'response.opus') : null,
      path.join(__dirname, 'response.opus'),
      path.join(__dirname, '..', 'response.opus'),
      path.join(__dirname, '..', '..', 'response.opus'),
    ].filter(Boolean);

    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { found: p, candidates }; } catch { }
    }
    return { found: null, candidates };
  }

  try {
    const settings = await getSettings();
    const creds = await resolveMetaCredentialsForContato(to, settings, opts);
    const phoneNumberId = creds?.phoneNumberId || null;
    const token = creds?.token || null;

    if (!phoneNumberId || !token) {
      return { ok: false, reason: 'missing-meta-credentials', phone_number_id: phoneNumberId || null };
    }

    // helper com escopo certo
    const uploadVoiceFile = async (filePath, filename) => {
      const mimesToTry = [
        'audio/ogg; codecs=opus',
        'audio/ogg',
        'audio/opus',
      ];

      let lastErr = null;
      for (const mt of mimesToTry) {
        try {
          const up = await metaUploadMediaFromPath({
            phoneNumberId,
            token,
            version: settings?.meta_api_version || 'v24.0',
            filePath,
            mimeType: mt,
            filename,
          });
          console.log('[AUDIO][META][UPLOAD]', JSON.stringify({ id: up.id, ...up.upload }));
          return up;
        } catch (e) {
          lastErr = e;
          console.log('[AUDIO][META][UPLOAD][fail]', JSON.stringify({
            mimeType: mt,
            error: e?.message || String(e),
          }));
        }
      }
      throw lastErr || new Error('upload failed');
    };

    // ✅ DEBUG: enviar response.opus
    if (opts && opts.send_response_opus) {
      const { found, candidates } = findResponseOpusPath();
      console.log('[AUDIO][response.opus][search]', JSON.stringify({
        found,
        candidates,
        cwd: process.cwd(),
        dirname: __dirname,
      }));

      if (!found) {
        return { ok: false, reason: 'missing-response-opus', tried: { candidates, cwd: process.cwd(), dirname: __dirname } };
      }

      logAudioInfo('response.opus', found, { source: 'debug', note: 'will-upload-as-voice.ogg' });

      const info = analyzeOggOpusFile(found);
      if (!info.isOgg) {
        return { ok: false, reason: 'response-opus-not-ogg', filePath: found, headHex: info.headHex };
      }
      if (info.ogg?.crcBadPages > 0) {
        return { ok: false, reason: 'response-opus-bad-crc', filePath: found, firstBadCrc: info.ogg.firstBadCrc };
      }

      const up = await uploadVoiceFile(found, 'voice.ogg');
      const rSend = await sendAudioByMediaId(to, up.id, { ...opts, voice_note: true });
      return { ...rSend, uploaded_media_id: up.id, sent_from: 'response.opus', filePath: found };
    }

    // 1) gera áudio (Eleven)
    tmpFile = await elevenTtsToTempFile(text, settings, opts);

    // 2) log antes do upload
    logAudioInfo('before-upload', tmpFile, { source: 'tmp-eleven' });

    // 🚫 NÃO patch aqui (quebra CRC e mata reprodução)
    // patchOpusHeadInputSampleRate(tmpFile, 24000);

    // 3) upload + send
    const up = await uploadVoiceFile(tmpFile, 'voice.ogg');
    const rSend = await sendAudioByMediaId(to, up.id, { ...opts, voice_note: true });

    const cfg = resolveElevenConfig(settings, opts);
    return {
      ...rSend,
      tts: { provider: 'elevenlabs', voice_id: cfg.voiceId, model_id: cfg.modelId, output_format: cfg.outputFormat },
      uploaded_media_id: up.id,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { }
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

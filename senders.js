// senders.js (META-only + SSE publish)
// - NÃO depende de ./utils.js, ./optout.js, ./stateManager.js
// - Guarda em memória o phone_number_id do inbound por lead (pra responder sempre pelo mesmo)
// - Resolve credenciais via bot_meta_numbers (token por número) e fallback em bot_settings.graph_api_access_token
// - Publica no SSE via publishMessage

const axios = require('axios');
const db = require('./db');
const { publishMessage } = require('./stream/events-bus');

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

async function sendImage(contato, urlOrItems, captionOrOpts, opts = {}) {
  // compat: sendImage(to, url, caption, opts) OU sendImage(to, [{url,caption}], opts)
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

module.exports = {
  rememberInboundMetaPhoneNumberId,
  resolveMetaCredentialsForContato,
  sendMessage,
  sendImage,
};

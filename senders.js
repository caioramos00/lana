// senders.js (META-only + SSE publish)
// - NÃO depende de ./lib/transport/meta.js
// - Resolve credenciais via bot_meta_numbers (preferindo o phone_number_id do inbound)
// - Publica no SSE via publishMessage

const axios = require('axios');

const { delayRange, extraGlobalDelay, BETWEEN_MIN_MS, BETWEEN_MAX_MS } = require('./utils.js');
const { preflightOptOut } = require('./optout.js');
const { ensureEstado } = require('./stateManager.js');
const { publishMessage } = require('./stream/events-bus');

const {
  getBotSettings,
  getMetaNumberByPhoneNumberId,
  getDefaultMetaNumber,
} = require('./db');

function _isPausedByOptOut(st) {
  return (
    st.permanentlyBlocked === true ||
    st.optOutCount >= 3 ||
    (st.optOutCount > 0 && !st.reoptinActive)
  );
}

/**
 * Resolve credenciais Meta (phone_number_id + token) para um contato.
 *
 * Prioridade do phone_number_id:
 *  1) opts.meta_phone_number_id (ex.: o mesmo phone_number_id do inbound)
 *  2) st.meta_phone_number_id (memória)
 *  3) settings.meta_phone_number_id (legado, se existir)
 *  4) default ativo em bot_meta_numbers
 *
 * Token:
 *  - Preferencialmente bot_meta_numbers.access_token
 *  - Fallback legado: settings.meta_access_token / settings.graph_api_access_token
 */
async function resolveMetaCredentialsForContato(contato, settings, opts = {}) {
  const st = ensureEstado(contato);

  const explicitPhoneNumberId = opts.meta_phone_number_id;
  const candidatePhoneNumberId =
    explicitPhoneNumberId ||
    st.meta_phone_number_id ||
    settings?.meta_phone_number_id ||
    null;

  let metaNumber = null;

  if (candidatePhoneNumberId) {
    try {
      metaNumber = await getMetaNumberByPhoneNumberId(candidatePhoneNumberId);
    } catch (e) {
      console.warn(
        `[${contato}] resolveMetaCredentialsForContato getMetaNumberByPhoneNumberId erro: ${e?.message || e}`
      );
    }
  }

  if (!metaNumber) {
    try {
      metaNumber = await getDefaultMetaNumber();
    } catch (e) {
      console.warn(
        `[${contato}] resolveMetaCredentialsForContato getDefaultMetaNumber erro: ${e?.message || e}`
      );
    }
  }

  if (metaNumber && metaNumber.active !== false) {
    return {
      phoneNumberId: metaNumber.phone_number_id,
      token: metaNumber.access_token,
    };
  }

  const legacyToken =
    settings?.meta_access_token ||
    settings?.graph_api_access_token ||
    null;

  return {
    phoneNumberId: candidatePhoneNumberId || null,
    token: legacyToken,
  };
}

function _getMetaApiVersion(settings) {
  // você pode guardar isso no settings depois; por enquanto default seguro
  return (settings?.meta_api_version || 'v24.0').trim();
}

function _metaMessagesUrl(version, phoneNumberId) {
  return `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
}

async function _metaSendText({ to, text }, { token, phoneNumberId, settings }) {
  const version = _getMetaApiVersion(settings);
  const url = _metaMessagesUrl(version, phoneNumberId);

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: {
      body: text,
      preview_url: false,
    },
  };

  const r = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  // Meta retorna 2xx com body contendo "messages":[{"id":"wamid..."}]
  if (r.status >= 200 && r.status < 300) return r.data || {};

  const errBody = r.data || {};
  const msg =
    errBody?.error?.message ||
    `HTTP ${r.status}`;

  throw new Error(`meta_send_text_failed: ${msg}`);
}

async function _metaSendImage({ to, url: link, caption }, { token, phoneNumberId, settings }) {
  const version = _getMetaApiVersion(settings);
  const url = _metaMessagesUrl(version, phoneNumberId);

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link },
  };

  if (caption && typeof caption === 'string' && caption.trim()) {
    payload.image.caption = caption.trim();
  }

  const r = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (r.status >= 200 && r.status < 300) return r.data || {};

  const errBody = r.data || {};
  const msg =
    errBody?.error?.message ||
    `HTTP ${r.status}`;

  throw new Error(`meta_send_image_failed: ${msg}`);
}

/**
 * Envia uma mensagem de TEXTO via Meta.
 * opts:
 *  - meta_phone_number_id: força responder pelo mesmo número do inbound
 *  - force: ignora pausa por optout
 *  - settings: (opcional) injeta settings já carregado, evita hit no DB
 */
async function sendMessage(contato, texto, opts = {}) {
  await extraGlobalDelay();

  const st = ensureEstado(contato);

  if (await preflightOptOut(st)) {
    console.log(`[${contato}] msg=cancelada por opt-out em tempo real`);
    return { ok: false, reason: 'paused-by-optout' };
  }

  if (_isPausedByOptOut(st) && !opts.force) {
    return { ok: false, reason: 'paused-by-optout' };
  }

  const body = String(texto ?? '');
  if (!body.trim()) return { ok: false, reason: 'empty-text' };

  const settings = opts.settings || global.botSettings || (await getBotSettings());

  const { phoneNumberId, token } = await resolveMetaCredentialsForContato(contato, settings, opts);

  if (!token || !phoneNumberId) {
    console.warn(
      `[${contato}] sendMessage: Meta credentials missing (token: ${!!token}, phoneNumberId: ${!!phoneNumberId})`
    );
    return { ok: false, reason: 'missing-meta-credentials' };
  }

  // cola no estado para próximas respostas
  try { st.meta_phone_number_id = phoneNumberId; } catch { }

  try {
    const resp = await _metaSendText(
      { to: contato, text: body },
      { token, phoneNumberId, settings }
    );

    const wamid = resp?.messages?.[0]?.id || '';

    try {
      publishMessage({
        dir: 'out',
        wa_id: contato,
        wamid,
        kind: 'text',
        text: body,
        media: null,
        ts: Date.now(),
      });
    } catch { }

    return { ok: true, provider: 'meta', wamid, phone_number_id: phoneNumberId };
  } catch (e) {
    console.log(`[${contato}] Msg send fail (meta): ${e?.message || e}`);
    return { ok: false, provider: 'meta', error: e?.message || String(e) };
  }
}

/**
 * Envia 1 imagem (url string) ou várias [{url, caption}] via Meta.
 * Assinatura compatível com a antiga:
 *   sendImage(contato, urlOrItems, captionOrOpts, opts?)
 *
 * opts:
 *  - meta_phone_number_id: força responder pelo mesmo número do inbound
 *  - delayBetweenMs: [min,max] delay entre itens (se batch)
 *  - force: ignora pausa por optout
 *  - settings: (opcional) injeta settings já carregado
 */
async function sendImage(contato, urlOrItems, captionOrOpts, opts = {}) {
  if (typeof captionOrOpts === 'object') {
    opts = captionOrOpts;
    captionOrOpts = undefined;
  }

  const st = ensureEstado(contato);

  const items = Array.isArray(urlOrItems)
    ? urlOrItems
    : [{ url: urlOrItems, caption: captionOrOpts }];

  const isArray = Array.isArray(urlOrItems);
  const cfg = { delayBetweenMs: [BETWEEN_MIN_MS, BETWEEN_MAX_MS], ...opts };

  await extraGlobalDelay();

  if (await preflightOptOut(st)) return { ok: false, reason: 'paused-by-optout' };
  if (_isPausedByOptOut(st) && !cfg.force) return { ok: false, reason: 'paused-by-optout' };

  const settings = cfg.settings || global.botSettings || (await getBotSettings());
  const { phoneNumberId, token } = await resolveMetaCredentialsForContato(contato, settings, cfg);

  if (!token || !phoneNumberId) {
    console.warn(
      `[${contato}] sendImage: Meta credentials missing (token: ${!!token}, phoneNumberId: ${!!phoneNumberId})`
    );
    return { ok: false, reason: 'missing-meta-credentials' };
  }

  try { st.meta_phone_number_id = phoneNumberId; } catch { }

  const results = [];

  for (let i = 0; i < items.length; i++) {
    const link = String(items[i]?.url || '');
    const caption = items[i]?.caption != null ? String(items[i].caption) : '';

    if (!/^https?:\/\//i.test(link)) {
      results.push({ ok: false, reason: 'invalid-url', url: link });
    } else {
      try {
        const resp = await _metaSendImage(
          { to: contato, url: link, caption },
          { token, phoneNumberId, settings }
        );

        const wamid = resp?.messages?.[0]?.id || '';
        results.push({ ok: true, wamid });

        try {
          publishMessage({
            dir: 'out',
            wa_id: contato,
            wamid,
            kind: 'image',
            text: caption || '',
            media: { type: 'image', link },
            ts: Date.now(),
          });
        } catch { }
      } catch (e) {
        console.warn(`[${contato}] sendImage(meta) error=${e?.message || e}`);
        results.push({ ok: false, reason: 'meta-exception', error: e?.message || String(e) });
      }
    }

    if (await preflightOptOut(st)) {
      results.push({ ok: false, reason: 'paused-by-optout-mid-batch' });
      break;
    }

    if (i < items.length - 1 && cfg.delayBetweenMs) {
      const [minMs, maxMs] = cfg.delayBetweenMs;
      await delayRange(minMs, maxMs);
    }
  }

  const okAll = results.every((r) => r?.ok);
  return isArray
    ? { ok: okAll, results, provider: 'meta', phone_number_id: phoneNumberId }
    : results[0];
}

/* ===========================
   STUBS (ManyChat desativado)
   =========================== */

async function resolveManychatSubscriberId() {
  return null;
}

async function updateManyChatCustomFieldByName() {
  return { ok: false, reason: 'manychat-disabled' };
}

async function sendManychatWaFlow() {
  return { ok: false, reason: 'manychat-disabled' };
}

module.exports = {
  // Meta-only
  resolveMetaCredentialsForContato,
  sendMessage,
  sendImage,

  // stubs (pra não quebrar imports antigos)
  resolveManychatSubscriberId,
  updateManyChatCustomFieldByName,
  sendManychatWaFlow,
};

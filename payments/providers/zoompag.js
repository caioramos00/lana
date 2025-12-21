// payments/providers/zoompag.js
'use strict';

function pick(obj, path) {
  if (!obj) return null;

  // suporta items[0].externalRef
  const parts = String(path).split('.').flatMap(p => {
    const m = p.match(/^(\w+)\[(\d+)\]$/);
    if (m) return [m[1], Number(m[2])];
    return [p];
  });

  let cur = obj;
  for (const k of parts) {
    if (cur == null) return null;

    if (typeof k === 'number') {
      if (!Array.isArray(cur) || k < 0 || k >= cur.length) return null;
      cur = cur[k];
      continue;
    }

    if (typeof cur !== 'object' || !(k in cur)) return null;
    cur = cur[k];
  }

  return cur == null ? null : cur;
}

function pickAny(obj, paths) {
  for (const p of paths) {
    const v = pick(obj, p);
    if (v != null) return v;
  }
  return null;
}

function upper(v) {
  return String(v || '').trim().toUpperCase();
}

function pickRequestId(headers) {
  if (!headers) return null;
  return headers['x-request-id'] || headers['x-correlation-id'] || headers['cf-ray'] || null;
}

function toZoompagError(err, meta = {}) {
  if (err?.response) {
    const status = err.response.status;
    const statusText = err.response.statusText || '';
    const data = err.response.data;
    const reqId = pickRequestId(err.response.headers);

    const providerMsg =
      (data && (data.message || data.error || data.details))
        ? (data.message || data.error || data.details)
        : (typeof data === 'string' ? data : null);

    const e = new Error(
      `Zoompag HTTP ${status}${statusText ? ` ${statusText}` : ''}` +
      (providerMsg ? `: ${providerMsg}` : '')
    );
    e.code = 'ZOOMPAG_HTTP';
    e.http_status = status;
    e.request_id = reqId || null;
    e.response_data = data || null;
    e.meta = meta;
    return e;
  }

  if (err?.request) {
    const e = new Error(`Zoompag NETWORK error: ${err?.message || 'request failed'}`);
    e.code = 'ZOOMPAG_NETWORK';
    e.meta = meta;
    return e;
  }

  const e = new Error(err?.message || 'Zoompag unknown error');
  e.code = err?.code || 'ZOOMPAG_UNKNOWN';
  e.meta = meta;
  return e;
}

// Normaliza "corpo" retornado pela Zoompag.
// Exemplo que você mandou vem assim:
// { status: true, data: { id, status: "PENDING", pix: { copyPaste, qrcodeUrl, qrcode(base64) } } }
function unwrapBody(respData) {
  const root = respData || {};
  const inner = (root && typeof root === 'object' && root.data && typeof root.data === 'object')
    ? root.data
    : root;
  return { root, inner };
}

module.exports = function createZoompagProvider({ axios, logger = console } = {}) {
  return {
    id: 'zoompag',
    requiresCallback: false, // Zoompag não precisa de callback para criar charge

    async createPix({ amount, external_id, payer, meta, settings }) {
      const baseUrl = String(settings?.zoompag_api_base_url || 'https://api.zoompag.com')
        .trim()
        .replace(/\/+$/, '');
      const createPath = String(settings?.zoompag_create_path || '/transactions')
        .trim()
        .replace(/^\/+/, '/');
      const apiKey = String(settings?.zoompag_api_key || '').trim();

      if (!apiKey) {
        const e = new Error('Zoompag config missing (api_key).');
        e.code = 'ZOOMPAG_CFG';
        throw e;
      }

      const amountInCents = Math.round(Number(amount || 0) * 100);

      const payload = {
        amount: amountInCents,
        method: 'PIX',
        customer: {
          name: payer?.name || 'Cliente',
          email: payer?.email || 'cliente@example.com',
          phone: payer?.phone || undefined,
          documentType: payer?.documentType || 'CPF',
          document: payer?.document || undefined,
        },
        items: [
          {
            title: meta?.offer_title || meta?.product_name || 'Pagamento',
            amount: amountInCents,
            quantity: 1,
            tangible: false,
            externalRef: external_id || undefined,
          }
        ],
      };

      const url = `${baseUrl}${createPath}`;

      try {
        const resp = await axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          timeout: 60000,
        });

        const respData = resp?.data || {};
        const { root, inner } = unwrapBody(respData);

        // ✅ id / status corretos: sempre prioriza inner (data)
        const transaction_id = pickAny(inner, ['id']) || pickAny(root, ['id']) || null;

        // status pode ser "PENDING" em inner, mas no root pode vir boolean (true/false)
        const statusRaw = pickAny(inner, ['status']) ?? pickAny(root, ['status']);
        const status =
          typeof statusRaw === 'string'
            ? statusRaw
            : (statusRaw === true ? 'PENDING' : (statusRaw === false ? 'FAILED' : 'PENDING'));

        // ✅ "copia e cola" (EMV) vem como copyPaste ou qrcodeUrl (no exemplo ambos são EMV)
        // "qrcode" (base64 png) NÃO é copia-e-cola, então fica como fallback final só se não tiver EMV.
        const qrcode =
          pickAny(inner, ['pix.copyPaste', 'pix.copy_paste', 'pix.qrcodeUrl', 'pix.qrCodeUrl', 'pix.qrcode_url']) ||
          pickAny(inner, ['pix.qrCode', 'pix.qrcode']) ||
          pickAny(root,  ['pix.copyPaste', 'pix.copy_paste', 'pix.qrcodeUrl', 'pix.qrCodeUrl', 'pix.qrcode_url']) ||
          pickAny(root,  ['pix.qrCode', 'pix.qrcode']) ||
          null;

        return {
          provider: 'zoompag',
          external_id,
          transaction_id,
          status,
          qrcode,
          raw: respData, // guarda o corpo inteiro (root), pra debug e auditoria
        };
      } catch (err) {
        throw toZoompagError(err, { step: 'createPix' });
      }
    },

    normalizeWebhook(payload) {
      // tenta cobrir: payload, payload.data, payload.data.data
      const root = payload || {};
      const inner =
        (root?.data && typeof root.data === 'object' && root.data.data && typeof root.data.data === 'object')
          ? root.data.data
          : (root?.data && typeof root.data === 'object' ? root.data : root);

      const transaction_id = pickAny(inner, ['id']) || null;
      const external_id = pickAny(inner, ['items[0].externalRef', 'externalRef']) || null;

      const statusRaw = pickAny(inner, ['status']) ?? pickAny(root, ['status']);
      const status =
        typeof statusRaw === 'string'
          ? statusRaw
          : (statusRaw === true ? 'PENDING' : (statusRaw === false ? 'FAILED' : null));

      const total = pickAny(inner, ['amount']); // cents
      const end_to_end =
        pickAny(inner, ['pix.end2endId', 'end2endId', 'pix.endToEnd']) || null;

      return {
        transaction_id,
        external_id,
        status,
        total: total != null ? Number(total) : null,
        end_to_end,
        raw: payload,
      };
    },

    isPaidStatus(status) {
      const st = upper(status);
      return st === 'PAID' || st === 'COMPLETED';
    },
  };
};

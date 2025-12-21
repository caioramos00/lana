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
    } else {
      if (typeof cur !== 'object' || !(k in cur)) return null;
      cur = cur[k];
    }
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

function upper(v) { return String(v || '').trim().toUpperCase(); }

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
      (data && (data.message || data.error || data.details)) ? (data.message || data.error || data.details)
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

module.exports = function createZoompagProvider({ axios, logger = console } = {}) {
  return {
    id: 'zoompag',
    requiresCallback: false, // ajuste se precisar

    async createPix({ amount, external_id, payer, meta, settings }) {
      const baseUrl = String(settings?.zoompag_api_base_url || 'https://api.zoompag.com').trim().replace(/\/+$/, '');
      const createPath = String(settings?.zoompag_create_path || '/transactions').trim().replace(/^\/+/, '/');
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
            title: meta?.offer_title || 'Pagamento',
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

        const data = resp?.data || {};
        const transaction_id = data.id || null;
        const status = data.status || 'PENDING';
        const qrcode = pickAny(data, ['pix.copyPaste', 'pix.copy_paste', 'pix.qrCode', 'pix.qrcode']) || null;

        return {
          provider: 'zoompag',
          external_id,
          transaction_id,
          status,
          qrcode,
          raw: data, // salva só o corpo (não o resp inteiro)
        };
      } catch (err) {
        throw toZoompagError(err, { step: 'createPix' });
      }
    },

    normalizeWebhook(payload) {
      const data = payload?.data || payload || {};
      const transaction_id = pickAny(data, ['id']) || null;
      const external_id = pickAny(data, ['items[0].externalRef', 'externalRef']) || null;
      const status = pickAny(data, ['status']) || null;
      const total = pickAny(data, ['amount']); // cents
      const end_to_end = pickAny(data, ['pix.end2endId', 'end2endId', 'pix.endToEnd']) || null;

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

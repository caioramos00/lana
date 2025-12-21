// payments/providers/rapdyn.js
'use strict';

function upper(v) { return String(v || '').trim().toUpperCase(); }

function pick(obj, paths) {
  for (const p of paths) {
    const parts = String(p).split('.');
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (!cur || typeof cur !== 'object' || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur != null) return cur;
  }
  return null;
}

function toCents(amountBRL) {
  const n = Number(amountBRL);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function docTypeAndValue(rawDoc) {
  const digits = String(rawDoc || '').replace(/\D/g, '');
  if (!digits) return { type: 'CPF', value: '' };
  return { type: digits.length > 11 ? 'CNPJ' : 'CPF', value: digits };
}

function isDataImage(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.startsWith('data:image/');
}

function pickRequestId(headers) {
  if (!headers) return null;
  return headers['x-request-id'] || headers['x-correlation-id'] || headers['cf-ray'] || null;
}

function toRapdynError(err, meta = {}) {
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
      `Rapdyn HTTP ${status}${statusText ? ` ${statusText}` : ''}` +
      (providerMsg ? `: ${providerMsg}` : '')
    );

    e.code = 'RAPDYN_HTTP';
    e.http_status = status;
    e.request_id = reqId || null;
    e.response_data = data || null;
    e.meta = meta;
    return e;
  }

  if (err?.request) {
    const e = new Error(`Rapdyn NETWORK error: ${err?.message || 'request failed'}`);
    e.code = 'RAPDYN_NETWORK';
    e.meta = meta;
    return e;
  }

  const e = new Error(err?.message || 'Rapdyn unknown error');
  e.code = err?.code || 'RAPDYN_UNKNOWN';
  e.meta = meta;
  return e;
}

module.exports = function createRapdynProvider({ axios, logger = console } = {}) {
  function baseUrl(settings) {
    const b = String(
      settings?.rapdyn_api_base_url ||
      global.rapdynConfig?.api_base_url ||
      global.botSettings?.rapdyn_api_base_url ||
      'https://app.rapdyn.io/api'
    ).trim();
    return b.replace(/\/+$/, '');
  }

  function createPath(settings) {
    const p = String(
      settings?.rapdyn_create_path ||
      global.rapdynConfig?.create_path ||
      global.botSettings?.rapdyn_create_path ||
      '/payments'
    ).trim();
    return p.startsWith('/') ? p : `/${p}`;
  }

  function creds(settings) {
    const api_key = String(
      settings?.rapdyn_api_key ||
      global.rapdynConfig?.api_key ||
      global.botSettings?.rapdyn_api_key ||
      ''
    ).trim();

    const api_secret = String(
      settings?.rapdyn_api_secret ||
      global.rapdynConfig?.api_secret ||
      global.botSettings?.rapdyn_api_secret ||
      ''
    ).trim();

    return { api_key, api_secret };
  }

  function authHeaders(settings) {
    const { api_key, api_secret } = creds(settings);

    // Doc padrão: Bearer TOKEN
    if (api_key) return { Authorization: `Bearer ${api_key}` };

    // fallback legado (se algum ambiente usar header próprio)
    if (api_key && api_secret) {
      return {
        'X-API-KEY': api_key,
        'X-API-SECRET': api_secret,
      };
    }

    return {};
  }

  async function createPixCharge(settings, payload) {
    const b = baseUrl(settings);
    if (!b) {
      const e = new Error('Rapdyn config missing (api_base_url).');
      e.code = 'RAPDYN_CONFIG';
      throw e;
    }

    try {
      const { data } = await axios.post(
        `${b}${createPath(settings)}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(settings),
          },
          timeout: 60000,
        }
      );
      return data;
    } catch (err) {
      throw toRapdynError(err, { step: 'createPixCharge' });
    }
  }

  return {
    id: 'rapdyn',
    requiresCallback: false,

    async createPix({ amount, external_id, callbackUrl, payer, meta, settings }) {
      const amountCents = toCents(amount);

      const doc = docTypeAndValue(payer?.document);
      const phone = String(payer?.phone || '').trim();

      const payload = {
        amount: amountCents,
        method: 'pix',
        external_id: external_id || undefined,
        customer: {
          name: payer?.name || 'Cliente',
          email: payer?.email || 'cliente@teste.com',
          phone: phone || undefined,
          document: {
            type: doc.type,
            value: doc.value,
          },
        },
        products: [
          {
            name: meta?.offer_title || meta?.product_name || 'Pagamento',
            price: amountCents,
            quantity: '1',
            type: 'digital',
          }
        ],
      };

      const data = await createPixCharge(settings, payload);

      const transaction_id = pick(data, ['id', 'transaction_id', 'transactionId', 'data.id']) || null;
      const status = pick(data, ['status', 'data.status']) || 'pending';

      let qrcode = pick(data, [
        'pix.copypaste',      // ✅ comum
        'pix.copyPaste',
        'pix.copy_and_paste',
        'pix.emv',
        'pix.code',
        'emv',
        'qrcode',
        'data.pix.copypaste',
        'data.pix.emv',
        'data.emv',
        'data.qrcode',
      ]) || null;

      if (qrcode && isDataImage(qrcode)) qrcode = null;

      return {
        provider: 'rapdyn',
        external_id,
        transaction_id,
        status: String(status),
        qrcode: qrcode ? String(qrcode) : null,
        raw: data,
      };
    },

    normalizeWebhook(payload) {
      const transaction_id = pick(payload, ['id']) || null;
      const external_id = pick(payload, ['external_id']) || null;
      const status = pick(payload, ['status']) || null;

      const total = pick(payload, ['total']);
      const end2end = pick(payload, ['pix.end2EndId', 'pix.end2EndID', 'pix.end_to_end', 'pix.e2e']);

      const platform_tax = pick(payload, ['platform_tax']);
      const transaction_tax = pick(payload, ['transaction_tax']);
      const security_reserve_tax = pick(payload, ['security_reserve_tax']);
      const comission = pick(payload, ['comission']);

      return {
        transaction_id: transaction_id ? String(transaction_id) : null,
        external_id: external_id ? String(external_id) : null,
        status: status ? String(status) : null,
        total: total != null ? Number(total) : null,
        end_to_end: end2end ? String(end2end) : null,
        platform_tax: platform_tax != null ? Number(platform_tax) : null,
        transaction_tax: transaction_tax != null ? Number(transaction_tax) : null,
        security_reserve_tax: security_reserve_tax != null ? Number(security_reserve_tax) : null,
        comission: comission != null ? Number(comission) : null,
        raw: payload || null,
      };
    },

    isPaidStatus(status) {
      const st = upper(status);
      return st === 'PAID' || st === 'COMPLETED' || st === 'CONFIRMED' || st === 'SUCCESS' || st === 'APPROVED';
    },
  };
};

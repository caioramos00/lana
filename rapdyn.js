// rapdyn.js
const axios = require('axios');

function baseUrl() {
  // Doc: https://app.rapdyn.io/api
  const b = String(
    global.rapdynConfig?.api_base_url ||
    global.botSettings?.rapdyn_api_base_url ||
    'https://app.rapdyn.io/api'
  ).trim();
  return b.replace(/\/+$/, '');
}

function createPath() {
  // Doc: POST /payments
  const p = String(
    global.rapdynConfig?.create_path ||
    global.botSettings?.rapdyn_create_path ||
    '/payments'
  ).trim();
  return p.startsWith('/') ? p : `/${p}`;
}

function token() {
  // Doc fala “token gerado na plataforma” via Bearer
  // Mantendo compat com nomes antigos (rapdyn_api_key etc.)
  return String(
    global.rapdynConfig?.token ||
    global.rapdynConfig?.api_token ||
    global.rapdynConfig?.api_key ||
    global.botSettings?.rapdyn_token ||
    global.botSettings?.rapdyn_api_token ||
    global.botSettings?.rapdyn_api_key ||
    ''
  ).trim();
}

function authHeaders() {
  const t = token();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}

function pickRequestId(headers) {
  if (!headers) return null;
  const h = headers || {};
  return h['x-request-id'] || h['x-correlation-id'] || h['cf-ray'] || null;
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

async function createPayment(payload) {
  const b = baseUrl();
  const t = token();
  if (!b) {
    const e = new Error('Rapdyn config missing (api_base_url).');
    e.code = 'RAPDYN_CONFIG';
    throw e;
  }
  if (!t) {
    const e = new Error('Rapdyn config missing (token).');
    e.code = 'RAPDYN_CONFIG';
    throw e;
  }

  try {
    const { data } = await axios.post(
      `${b}${createPath()}`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...authHeaders(),
        },
        timeout: 60000,
      }
    );
    return data;
  } catch (err) {
    throw toRapdynError(err, { step: 'createPayment' });
  }
}

module.exports = { createPayment };

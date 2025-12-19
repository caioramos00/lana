// rapdyn.js
const axios = require('axios');

function baseUrl() {
  const b = String(
    global.rapdynConfig?.api_base_url ||
    global.botSettings?.rapdyn_api_base_url ||
    'https://app.rapdyn.io/api'
  ).trim();
  return b.replace(/\/+$/, '');
}

function createPath() {
  const p = String(
    global.rapdynConfig?.create_path ||
    global.botSettings?.rapdyn_create_path ||
    '/payments'
  ).trim();
  return p.startsWith('/') ? p : `/${p}`;
}

function creds() {
  // Doc: Authorization: Bearer [SEU_TOKEN]
  const api_key = String(global.rapdynConfig?.api_key || global.botSettings?.rapdyn_api_key || '').trim();
  const api_secret = String(global.rapdynConfig?.api_secret || global.botSettings?.rapdyn_api_secret || '').trim();
  return { api_key, api_secret };
}

function authHeaders() {
  const { api_key, api_secret } = creds();
  if (!api_key && !api_secret) return {};

  // Prioriza Bearer (doc)
  if (api_key) {
    return { Authorization: `Bearer ${api_key}` };
  }

  // fallback legado (se alguém usar header próprio)
  if (api_key && api_secret) {
    return {
      'X-API-KEY': api_key,
      'X-API-SECRET': api_secret,
    };
  }

  return {};
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
      (data && (data.message || data.error || data.details)) ? (data.message || data.error || data.details)
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

async function createPixCharge(payload) {
  const b = baseUrl();
  if (!b) {
    const e = new Error('Rapdyn config missing (api_base_url).');
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
          ...authHeaders(),
        },
        timeout: 60000,
      }
    );
    return data;
  } catch (err) {
    throw toRapdynError(err, { step: 'createPixCharge' });
  }
}

module.exports = { createPixCharge };

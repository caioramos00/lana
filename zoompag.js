const axios = require('axios');

function baseUrl() {
  return String(global.zoompagConfig?.api_base_url || global.botSettings?.zoompag_api_base_url || 'https://api.zoompag.com').trim().replace(/\/+$/, '');
}

function createPath() {
  return String(global.zoompagConfig?.create_path || global.botSettings?.zoompag_create_path || '/transactions').trim().replace(/^\/+/, '/');
}

function getApiKey() {
  return String(global.zoompagConfig?.api_key || global.botSettings?.zoompag_api_key || '').trim();
}

function authHeaders() {
  const api_key = getApiKey();
  return api_key ? { 'x-api-key': api_key } : {};
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

async function createPixCharge(payload) {
  const b = baseUrl();
  if (!b) throw new Error('Zoompag config missing (api_base_url).');
  const key = getApiKey();
  if (!key) throw new Error('Zoompag config missing (api_key).');
  const url = `${b}${createPath()}`;
  const headers = { 'Content-Type': 'application/json', ...authHeaders() };
  try {
    const { data } = await axios.post(url, payload, {
      headers,
      timeout: 60000,
    });
    return data;
  } catch (err) {
    if (err.response) {
    }
    throw toZoompagError(err, { step: 'createPixCharge' });
  }
}

module.exports = { createPixCharge };
// veltrax.js
const axios = require('axios');

let _jwt = null;
let _jwtTs = 0;
const JWT_TTL_MS = 10 * 60 * 1000;

function baseUrl() {
  const b = String(
    global.veltraxConfig?.api_base_url ||
    global.botSettings?.veltrax_api_base_url ||
    'https://api.veltraxpay.com'
  ).trim();
  return b.replace(/\/+$/, '');
}

function creds() {
  const client_id = String(
    global.veltraxConfig?.client_id ||
    global.botSettings?.veltrax_client_id ||
    ''
  ).trim();

  const client_secret = String(
    global.veltraxConfig?.client_secret ||
    global.botSettings?.veltrax_client_secret ||
    ''
  ).trim();

  return { client_id, client_secret };
}

function pickRequestId(headers) {
  if (!headers) return null;
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    null
  );
}

function toVeltraxError(err, meta = {}) {
  // Axios HTTP error
  if (err?.response) {
    const status = err.response.status;
    const statusText = err.response.statusText || '';
    const data = err.response.data;
    const reqId = pickRequestId(err.response.headers);

    const providerMsg =
      (data && (data.message || data.error || data.details)) ? (data.message || data.error || data.details)
        : (typeof data === 'string' ? data : null);

    const e = new Error(
      `Veltrax HTTP ${status}${statusText ? ` ${statusText}` : ''}` +
      (providerMsg ? `: ${providerMsg}` : '')
    );

    e.code = 'VELTRAX_HTTP';
    e.http_status = status;
    e.request_id = reqId || null;
    e.response_data = data || null;
    e.meta = meta;
    return e;
  }

  // Axios network/timeout error
  if (err?.request) {
    const e = new Error(`Veltrax NETWORK error: ${err?.message || 'request failed'}`);
    e.code = 'VELTRAX_NETWORK';
    e.meta = meta;
    return e;
  }

  // Generic
  const e = new Error(err?.message || 'Veltrax unknown error');
  e.code = err?.code || 'VELTRAX_UNKNOWN';
  e.meta = meta;
  return e;
}

async function getJwt() {
  const now = Date.now();
  if (_jwt && (now - _jwtTs) < JWT_TTL_MS) return _jwt;

  const { client_id, client_secret } = creds();
  if (!client_id || !client_secret) {
    const e = new Error('Veltrax config missing (client_id/client_secret).');
    e.code = 'VELTRAX_CONFIG';
    e.meta = {
      has_global_veltraxConfig: !!global.veltraxConfig,
      has_global_botSettings: !!global.botSettings,
      botSettings_has_client_id: !!String(global.botSettings?.veltrax_client_id || '').trim(),
      botSettings_has_client_secret: !!String(global.botSettings?.veltrax_client_secret || '').trim(),
    };
    throw e;
  }

  try {
    const { data } = await axios.post(
      `${baseUrl()}/api/auth/login`,
      { client_id, client_secret },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const token = data?.token || null;
    if (!token) throw new Error('Veltrax login did not return token.');

    _jwt = token;
    _jwtTs = now;
    return _jwt;
  } catch (err) {
    throw toVeltraxError(err, { step: 'auth/login' });
  }
}

async function createDeposit(payload) {
  const jwt = await getJwt();

  try {
    const { data } = await axios.post(
      `${baseUrl()}/api/payments/deposit`,
      payload,
      {
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      }
    );
    return data;
  } catch (err) {
    throw toVeltraxError(err, {
      step: 'payments/deposit',
      external_id: payload?.external_id,
      amount: payload?.amount,
    });
  }
}

module.exports = { createDeposit };

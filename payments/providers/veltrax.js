// payments/providers/veltrax.js
'use strict';

function upper(v) { return String(v || '').trim().toUpperCase(); }

function pickRequestId(headers) {
  if (!headers) return null;
  return headers['x-request-id'] || headers['x-correlation-id'] || headers['cf-ray'] || null;
}

function toVeltraxError(err, meta = {}) {
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

  if (err?.request) {
    const e = new Error(`Veltrax NETWORK error: ${err?.message || 'request failed'}`);
    e.code = 'VELTRAX_NETWORK';
    e.meta = meta;
    return e;
  }

  const e = new Error(err?.message || 'Veltrax unknown error');
  e.code = err?.code || 'VELTRAX_UNKNOWN';
  e.meta = meta;
  return e;
}

module.exports = function createVeltraxProvider({ axios, logger = console } = {}) {
  // cache de JWT por instância do provider
  let _jwt = null;
  let _jwtTs = 0;
  const JWT_TTL_MS = 10 * 60 * 1000;

  function baseUrl(settings) {
    const b = String(
      settings?.veltrax_api_base_url ||
      global.veltraxConfig?.api_base_url ||
      global.botSettings?.veltrax_api_base_url ||
      'https://api.veltraxpay.com'
    ).trim();
    return b.replace(/\/+$/, '');
  }

  function creds(settings) {
    const client_id = String(
      settings?.veltrax_client_id ||
      global.veltraxConfig?.client_id ||
      global.botSettings?.veltrax_client_id ||
      ''
    ).trim();

    const client_secret = String(
      settings?.veltrax_client_secret ||
      global.veltraxConfig?.client_secret ||
      global.botSettings?.veltrax_client_secret ||
      ''
    ).trim();

    return { client_id, client_secret };
  }

  async function getJwt(settings) {
    const now = Date.now();
    if (_jwt && (now - _jwtTs) < JWT_TTL_MS) return _jwt;

    const { client_id, client_secret } = creds(settings);
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
        `${baseUrl(settings)}/api/auth/login`,
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

  async function createDeposit(settings, payload) {
    const jwt = await getJwt(settings);

    try {
      const { data } = await axios.post(
        `${baseUrl(settings)}/api/payments/deposit`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
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

  return {
    id: 'veltrax',
    requiresCallback: true,

    async createPix({ amount, external_id, callbackUrl, payer, meta, settings }) {
      const payload = {
        amount,
        external_id,
        clientCallbackUrl: callbackUrl,
        payer: {
          name: payer?.name,
          email: payer?.email,
          document: payer?.document,
          phone: payer?.phone || undefined,
        },
        meta: meta || undefined,
      };

      const data = await createDeposit(settings, payload);

      const transaction_id =
        data?.qrCodeResponse?.transactionId ||
        data?.transactionId ||
        null;

      const status =
        data?.qrCodeResponse?.status ||
        data?.status ||
        'PENDING';

      const qrcode =
        data?.qrCodeResponse?.qrcode ||
        data?.qrcode ||
        null;

      return {
        provider: 'veltrax',
        external_id,
        transaction_id,
        status: String(status),
        qrcode: qrcode ? String(qrcode) : null,
        raw: data,
      };
    },

    normalizeWebhook(payload) {
      const transaction_id = payload?.transaction_id || payload?.transactionId || null;
      const external_id = payload?.external_id || payload?.externalId || null;
      const status = payload?.status || null;

      const fee = payload?.fee != null ? Number(payload.fee) : null;
      const net_amount =
        payload?.net_amount != null ? Number(payload.net_amount)
          : (payload?.net_amout != null ? Number(payload.net_amout) : null);

      const end_to_end = payload?.end_to_end || payload?.endToEnd || null;

      return {
        transaction_id,
        external_id,
        status: status ? String(status) : null,
        fee: Number.isFinite(fee) ? fee : null,
        net_amount: Number.isFinite(net_amount) ? net_amount : null,
        end_to_end,
        raw: payload || null,
      };
    },

    isPaidStatus(status) {
      const st = upper(status);
      return st === 'COMPLETED' || st === 'PAID' || st === 'CONFIRMED' || st === 'SUCCESS';
    },
  };
};

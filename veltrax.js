const axios = require('axios');

let _jwt = null;
let _jwtTs = 0;
const JWT_TTL_MS = 10 * 60 * 1000;

function baseUrl() {
    const b = (global.veltraxConfig?.api_base_url || 'https://api.veltraxpay.com').trim();
    return b.replace(/\/+$/, '');
}

function creds() {
    return {
        client_id: (global.veltraxConfig?.client_id || '').trim(),
        client_secret: (global.veltraxConfig?.client_secret || '').trim(),
    };
}

async function getJwt() {
    const now = Date.now();
    if (_jwt && (now - _jwtTs) < JWT_TTL_MS) return _jwt;

    const { client_id, client_secret } = creds();
    if (!client_id || !client_secret) {
        const e = new Error('Veltrax config missing (client_id/client_secret).');
        e.code = 'VELTRAX_CONFIG';
        throw e;
    }

    const { data } = await axios.post(`${baseUrl()}/api/auth/login`, { client_id, client_secret }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
    });

    const token = data?.token || null;
    if (!token) throw new Error('Veltrax login did not return token.');

    _jwt = token;
    _jwtTs = now;
    return _jwt;
}

async function createDeposit(payload) {
    const jwt = await getJwt();
    const { data } = await axios.post(`${baseUrl()}/api/payments/deposit`, payload, {
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        timeout: 60000,
    });
    return data;
}

module.exports = { createDeposit };

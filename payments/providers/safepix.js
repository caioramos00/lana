'use strict';

function maskSecret(v, keep = 4) {
    const s = String(v || '');
    if (!s) return null;
    if (s.length <= keep) return '*'.repeat(s.length);
    return `${'*'.repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}`;
}

function safeJsonSnippet(v, max = 1200) {
    try {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (!s) return null;
        return s.length > max ? s.slice(0, max) + '…' : s;
    } catch {
        return '[unserializable]';
    }
}

function pick(obj, path) {
    if (!obj) return null;

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

function toSafepixError(err, meta = {}) {
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
            `SafePix HTTP ${status}${statusText ? ` ${statusText}` : ''}` +
            (providerMsg ? `: ${providerMsg}` : '')
        );
        e.code = 'SAFEPIX_HTTP';
        e.http_status = status;
        e.request_id = reqId || null;
        e.response_data = data || null;
        e.meta = meta;
        return e;
    }

    if (err?.request) {
        const e = new Error(`SafePix NETWORK error: ${err?.message || 'request failed'}`);
        e.code = 'SAFEPIX_NETWORK';
        e.meta = meta;
        return e;
    }

    const e = new Error(err?.message || 'SafePix unknown error');
    e.code = err?.code || 'SAFEPIX_UNKNOWN';
    e.meta = meta;
    return e;
}

function unwrapBody(respData) {
    const root = respData || {};
    const inner =
        (root && typeof root === 'object' && root.data && typeof root.data === 'object')
            ? root.data
            : root;
    return { root, inner };
}

function toAmountCents(amount) {
    // amount aqui vem em BRL (ex.: 1.20) e SafePix pede em centavos (ex.: 120)
    const n = Number(amount || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
}

function buildBasicAuth(publicKey, secretKey) {
    const raw = `${publicKey}:${secretKey}`;
    return 'Basic ' + Buffer.from(raw).toString('base64');
}

module.exports = function createSafepixProvider({ axios, logger = console } = {}) {
    return {
        id: 'safepix',
        requiresCallback: false,

        async createPix({ amount, external_id, callbackUrl, payer, meta, settings }) {
            const baseUrl = String(settings?.safepix_api_base_url || 'https://api.safepix.pro')
                .trim()
                .replace(/\/+$/, '');

            const createPath = String(settings?.safepix_create_path || '/v1/payment-transactions/create')
                .trim()
                .replace(/^\/+/, '/');

            // ===== Auth: Basic Base64(PUBLIC:SECRET) =====
            let publicKey = String(settings?.safepix_public_key || '').trim();
            let secretKey = String(settings?.safepix_secret_key || '').trim();

            // Backward compat:
            // - se você ainda não criou as colunas novas, pode colocar em safepix_api_key:
            //   "PUBLIC:SECRET"  (ou só SECRET, mas aí exige public_key separada)
            const legacy = String(settings?.safepix_api_key || '').trim();
            if ((!publicKey || !secretKey) && legacy && legacy.includes(':')) {
                const [p, s] = legacy.split(':', 2).map(x => String(x || '').trim());
                if (!publicKey && p) publicKey = p;
                if (!secretKey && s) secretKey = s;
            } else if (!secretKey && legacy && !legacy.includes(':')) {
                // se legacy for só o secret
                secretKey = legacy;
            }

            logger.log('[SAFEPIX][CREATE][CFG]', {
                baseUrl,
                createPath,
                url,
                hasPublicKey: !!publicKey,
                secretKeyMasked: maskSecret(secretKey),
                callbackUrl: callbackUrl || null,
                external_id,
                wa_id: meta?.wa_id || null,
                offer_id: meta?.offer_id || null,
            });

            if (!publicKey || !secretKey) {
                const e = new Error('SafePix config missing (public_key / secret_key).');
                e.code = 'SAFEPIX_CFG';
                throw e;
            }

            const amountInCents = toAmountCents(amount);
            if (!amountInCents) {
                const e = new Error('SafePix invalid amount (<= 0).');
                e.code = 'SAFEPIX_AMOUNT';
                throw e;
            }

            // ===== Body conforme seus testes (hardcoded onde você pediu) =====
            const customerExternalRef =
                meta?.wa_id ? `wa_${meta.wa_id}` : (external_id || undefined);

            const title = meta?.offer_title || meta?.product_name || 'Pagamento';
            const itemExternalRef = meta?.offer_id || meta?.plan_id || meta?.sku || 'item_1';

            const payload = {
                payment_method: 'pix',
                customer: {
                    document: {
                        type: 'CPF',
                        number: '12345678900', // hardcoded
                    },
                    name: 'João Silva', // hardcoded
                    email: 'joao@example.com', // hardcoded
                    phone: '+5511999999999', // hardcoded
                    external_ref: customerExternalRef,
                },
                items: [
                    {
                        title,
                        unit_price: amountInCents, // centavos
                        quantity: 1,
                        tangible: false,
                        external_ref: itemExternalRef,
                    },
                ],
                amount: amountInCents, // centavos
                postback_url: callbackUrl || undefined,
                traceable: true,
                ip: meta?.ip || '127.0.0.1',
                metadata: {
                    provider_name: meta?.provider_name || 'Lany',
                    wa_id: meta?.wa_id || null,
                    offer_id: meta?.offer_id || null,
                    external_id: external_id || null,
                },
            };

            logger.log('[SAFEPIX][CREATE][REQ]', {
                method: 'POST',
                url,
                amount,
                amountInCents,
                external_id,
                postback_url: payload.postback_url || null,
                payloadSnippet: safeJsonSnippet(payload, 1000),
            });

            const url = `${baseUrl}${createPath}`;

            try {
                const resp = await axios.post(url, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': buildBasicAuth(publicKey, secretKey),
                    },
                    timeout: 60000,
                });

                logger.log('[SAFEPIX][CREATE][RESP]', {
                    http_status: resp?.status,
                    url,
                    external_id,
                    respSnippet: safeJsonSnippet(resp?.data, 1200),
                });

                const respData = resp?.data || {};
                const { inner } = unwrapBody(respData);

                // Resposta conforme exemplo:
                // { data: { id, amount, status, pix: { qr_code } } }
                const transaction_id = pickAny(inner, ['id', 'Id']) || null;

                const statusRaw = pickAny(inner, ['status', 'Status']) || 'PENDING';
                const status = String(statusRaw || 'PENDING');

                const qrcode =
                    pickAny(inner, [
                        'pix.qr_code',
                        'pix.qrCode',
                        'pix.qrcode',
                        'pix.qr_code_text',
                        'pix.copyPaste',
                    ]) || null;

                return {
                    provider: 'safepix',
                    external_id,
                    transaction_id,
                    status,
                    qrcode,
                    raw: respData,
                };
            } catch (err) {
                const status = err?.response?.status || null;
                const statusText = err?.response?.statusText || null;
                const axiosUrl = err?.config?.url || null;
                const axiosMethod = err?.config?.method || null;

                logger.error('[SAFEPIX][CREATE][ERR]', {
                    url,
                    axiosUrl,
                    axiosMethod,
                    http_status: status,
                    statusText,
                    responseHeaders: err?.response?.headers || null,
                    responseDataSnippet: safeJsonSnippet(err?.response?.data, 1600),
                    message: err?.message || null,
                    external_id,
                });

                throw toSafepixError(err, { step: 'createPix', url, baseUrl, createPath });
            }
        },

        normalizeWebhook(payload) {
            const root = payload || {};

            // Webhook real (seu exemplo) vem flat e PascalCase
            const transaction_id =
                pickAny(root, ['Id', 'id']) ||
                null;

            const ourExternalId =
                pickAny(root, [
                    'metadata.external_id',
                    'metadata.externalId',
                    'Metadata.external_id',
                    'Metadata.externalId',
                ]) || null;

            const statusRaw =
                pickAny(root, ['Status', 'status']) ||
                null;

            const total =
                pickAny(root, ['Amount', 'amount']) ??
                null;

            // “ExternalId” do webhook parece ser um id do provedor (não o nosso external_id),
            // então guardamos como end_to_end (ou só em raw_webhook no DB).
            const providerExternalId =
                pickAny(root, ['ExternalId', 'externalId', 'external_id']) ||
                null;

            return {
                transaction_id,
                external_id: ourExternalId, // webhook não traz um reference nosso confiável
                status: statusRaw != null ? String(statusRaw) : null,
                total: total != null ? Number(total) : null, // no webhook vem 1.2 (BRL)
                end_to_end: providerExternalId,
                raw: payload,
            };
        },

        isPaidStatus(status) {
            const st = upper(status);
            return (
                st === 'PAID' ||
                st === 'COMPLETED' ||
                st === 'APPROVED' ||
                st === 'CONFIRMED' ||
                st === 'SETTLED'
            );
        },
    };
};

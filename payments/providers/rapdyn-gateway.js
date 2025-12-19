// payments/providers/rapdyn-gateway.js
const rapdyn = require('../../rapdyn');

function upper(v) {
  return String(v || '').trim().toUpperCase();
}

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

// ===== DEBUG HELPERS =====
function isDataImage(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.startsWith('data:image/');
}

function looksLikePixCopyPaste(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  const up = s.toUpperCase();
  return (
    (up.startsWith('000201') || up.includes('BR.GOV.BCB.PIX')) &&
    s.length >= 25
  );
}

function maskValue(v) {
  const s = String(v || '');
  const len = s.length;

  // mostra um preview curto pra não vazar completo
  if (len <= 80) return s;
  return `${s.slice(0, 30)}...(len=${len})...${s.slice(-18)}`;
}

function listStringFields(obj, opts = {}) {
  const {
    maxNodes = 2000,
    maxDepth = 12,
  } = opts;

  const out = [];
  const seen = new Set();
  let nodes = 0;

  function walk(cur, path, depth) {
    if (nodes++ > maxNodes) return;
    if (depth > maxDepth) return;

    if (cur && typeof cur === 'object') {
      if (seen.has(cur)) return;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (let i = 0; i < cur.length; i++) {
          walk(cur[i], `${path}[${i}]`, depth + 1);
        }
        return;
      }

      for (const k of Object.keys(cur)) {
        const nextPath = path ? `${path}.${k}` : k;
        walk(cur[k], nextPath, depth + 1);
      }
      return;
    }

    if (typeof cur === 'string') {
      out.push({ path, value: cur });
    }
  }

  walk(obj, '', 0);
  return out;
}

function isDebugEnabled() {
  return !!(
    global.botSettings.rapdyn_debug = true
  );
}

module.exports = {
  id: 'rapdyn',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    // DOC: POST https://app.rapdyn.io/api/payments
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

    const data = await rapdyn.createPixCharge(payload);

    // ✅ DEBUG: loga como chega (sem vazar tudo)
    if (isDebugEnabled()) {
      try {
        const topKeys = (data && typeof data === 'object' && !Array.isArray(data))
          ? Object.keys(data)
          : [];

        const strings = listStringFields(data);
        const copyCandidates = strings
          .filter(x => looksLikePixCopyPaste(x.value))
          .map(x => ({ path: x.path, preview: maskValue(x.value) }));

        const imageCandidates = strings
          .filter(x => isDataImage(x.value))
          .map(x => ({ path: x.path, preview: maskValue(x.value) }));

        console.log('[RAPDYN][CREATE][RESP][SUMMARY]', {
          external_id,
          topKeys,
          stringFields: strings.length,
          copyPasteCandidates: copyCandidates.length,
          dataImageCandidates: imageCandidates.length,
        });

        if (copyCandidates.length) {
          console.log('[RAPDYN][CREATE][RESP][COPY_PASTE_CANDIDATES]', copyCandidates);
        } else {
          console.log('[RAPDYN][CREATE][RESP][COPY_PASTE_CANDIDATES]', 'NONE');
        }

        if (imageCandidates.length) {
          console.log('[RAPDYN][CREATE][RESP][DATA_IMAGE_CANDIDATES]', imageCandidates);
        }
      } catch (e) {
        console.log('[RAPDYN][CREATE][RESP][DEBUG_ERR]', { message: e?.message });
      }
    }

    // A resposta da Rapdyn pode variar, então tentamos extrair os campos mais comuns:
    const transaction_id = pick(data, ['id', 'transaction_id', 'transactionId', 'data.id']) || null;
    const status = pick(data, ['status', 'data.status']) || 'pending';

    // OBS: aqui mantém tua lista.
    // Depois do log, você vai saber o path certo do "copia e cola"
    const qrcode = pick(data, [
      'pix.emv',
      'pix.qrCode',
      'pix.qrcode',
      'pix.copy_and_paste',
      'pix.code',
      'qrcode',
      'emv',
      'data.pix.emv',
      'data.emv',
      'data.qrcode',
    ]) || null;

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
    // DOC webhook:
    // { notification_type:'transaction', id:'...', total:10000, method:'pix', status:'paid', external_id:'...', pix:{end2EndId}, ... }
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
    // doc: processing, pending, paid, failed, returned, cancelled, blocked, med
    return st === 'PAID' || st === 'COMPLETED' || st === 'CONFIRMED' || st === 'SUCCESS' || st === 'APPROVED';
  },
};

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

function isDataImage(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.startsWith('data:image/');
}

function looksLikePixCopyPaste(v) {
  const s = String(v || '').trim();
  if (!s) return false;

  const up = s.toUpperCase();
  // BR Code (EMV) do PIX geralmente começa com 000201
  // ou contém o domínio BR.GOV.BCB.PIX
  const ok =
    up.startsWith('000201') ||
    up.includes('BR.GOV.BCB.PIX');

  // geralmente é bem grande; evita pegar lixo curto
  return ok && s.length >= 25;
}

function extractPixCopyPaste(data) {
  // Campos mais prováveis para "copia e cola" (prioridade alta)
  const preferredPaths = [
    'pix.copy_and_paste',
    'pix.copyAndPaste',
    'pix.copy_paste',
    'pix.copiaecola',
    'pix.copia_e_cola',
    'pix.emv',
    'pix.brCode',
    'pix.br_code',
    'pix.payload',
    'pix.code',
    'pix.brcode',
    'pix.pixCopiaECola',
    'data.pix.copy_and_paste',
    'data.pix.emv',
    'data.pix.brCode',
    'data.pix.payload',
    'data.emv',
    'data.brCode',
  ];

  for (const path of preferredPaths) {
    const val = pick(data, [path]);
    if (!val) continue;

    const s = String(val).trim();
    if (!s) continue;

    // se veio imagem base64/data:image, ignora
    if (isDataImage(s)) continue;

    // se parece BR Code, já retorna
    if (looksLikePixCopyPaste(s)) return s;
  }

  // Fallback: tenta achar algum campo textual que seja BR Code,
  // mas evita explicitamente os que são imagem.
  const fallbackPaths = [
    'qrcode',
    'qr_code',
    'qrCode',
    'pix.qrcode',
    'pix.qr_code',
    'pix.qrCode',
    'data.qrcode',
  ];

  for (const path of fallbackPaths) {
    const val = pick(data, [path]);
    if (!val) continue;

    const s = String(val).trim();
    if (!s) continue;

    if (isDataImage(s)) continue;
    if (looksLikePixCopyPaste(s)) return s;
  }

  return null;
}

module.exports = {
  id: 'rapdyn',

  async createPix({ amount, external_id, callbackUrl, payer, meta }) {
    const amountCents = toCents(amount);

    const doc = docTypeAndValue(payer?.document);
    const phone = String(payer?.phone || '').trim();

    // DOC: POST /payments
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

    const transaction_id =
      pick(data, ['id', 'transaction_id', 'transactionId', 'data.id']) || null;

    const status =
      pick(data, ['status', 'data.status']) || 'pending';

    // ✅ aqui é a correção: "qrcode" vira SEMPRE copia e cola (EMV/BR Code)
    const copyPaste = extractPixCopyPaste(data);

    return {
      provider: 'rapdyn',
      external_id,
      transaction_id,
      status: String(status),
      qrcode: copyPaste ? String(copyPaste) : null, // <- handler envia isso no WhatsApp
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

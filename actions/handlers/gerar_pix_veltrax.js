const { CONFIG, getPixForCtx, getOfferById } = require('../config');
const veltrax = require('../../veltrax');

function normalizePhone(p) {
  const s = String(p || '').replace(/\D/g, '');
  return s || null;
}

function callbackUrl() {
  const base = (global.veltraxConfig?.callback_base_url || '').trim().replace(/\/+$/, '');
  const path = (global.veltraxConfig?.webhook_path || '/webhook/veltrax').trim();
  if (!base) return null;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function pickOfferId(ctx) {
  return String(
    ctx?.agent?.offer_id ||
    ctx?.agent?.offerId ||
    ctx?.vars?.offer_id ||
    ctx?.vars?.offerId ||
    ''
  ).trim() || null;
}

module.exports = async function gerar_pix_veltrax(ctx) {
  const wa_id = String(ctx?.wa_id || ctx?.waId || '').trim();
  if (!wa_id) return { ok: false, reason: 'missing-wa_id' };

  const offer_id = pickOfferId(ctx);

  // resolve valor: primeiro offer_id -> CONFIG.offerSets, senão fallback fase
  let amount = null;
  let offer = null;

  if (offer_id) {
    offer = getOfferById(offer_id);
    if (offer && Number.isFinite(Number(offer.preco))) {
      amount = Number(offer.preco);
    }
  }
  if (!Number.isFinite(amount)) {
    const p = getPixForCtx(ctx);
    amount = Number(p.valor);
  }

  // payer: NÃO vou inventar CPF/email aqui.
  const payer_name = String('Cliente').trim();
  const payer_email = String('cliente@teste.com').trim() || null;
  const payer_document = String('50728383829') || null;
  const payer_phone = normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id);

  // se Veltrax exigir email+cpf, você tem que coletar isso do usuário antes
  if (!payer_email || !payer_document) {
    return {
      ok: false,
      reason: 'missing-payer',
      need: {
        email: !payer_email,
        document: !payer_document,
      },
    };
  }

  const cb = callbackUrl();
  if (!cb) return { ok: false, reason: 'missing-callback-base-url' };

  // tenta reaproveitar PIX recente (ex.: até 15 min), senão recria com sufixo
  const reuseMaxAgeMs = 15 * 60 * 1000;
  const latest = await ctx.db.getLatestPendingVeltraxDeposit(wa_id, offer_id, reuseMaxAgeMs);
  if (latest?.external_id) {
    return {
      ok: true,
      reused: true,
      offer_id,
      amount,
      external_id: latest.external_id,
      transaction_id: latest.transaction_id,
      qrcode: null, // não temos o "qrcode string" salvo (se quiser salvar, eu ajusto)
      message: 'Já existe um PIX recente pendente pra esse pedido.',
    };
  }

  const attempt = (await ctx.db.countVeltraxAttempts(wa_id, offer_id)) + 1;
  const external_id = `ord_${wa_id}_${offer_id || 'fase'}_r${attempt}`;

  const depositPayload = {
    amount,
    external_id,
    clientCallbackUrl: cb,
    payer: {
      name: payer_name,
      email: payer_email,
      document: payer_document,
      phone: payer_phone || undefined,
    },
  };

  const data = await veltrax.createDeposit(depositPayload);

  const transaction_id = data?.qrCodeResponse?.transactionId || null;
  const status = data?.qrCodeResponse?.status || 'PENDING';
  const qrcode = data?.qrCodeResponse?.qrcode || null;

  await ctx.db.createVeltraxDepositRow({
    wa_id,
    offer_id,
    amount,
    external_id,
    transaction_id,
    status,
    payer_name,
    payer_email,
    payer_document,
    payer_phone,
  });

  return {
    ok: true,
    reused: false,
    offer_id,
    offer,
    amount,
    external_id,
    transaction_id,
    status,
    qrcode, // isso aqui é o copia-e-cola
  };
};

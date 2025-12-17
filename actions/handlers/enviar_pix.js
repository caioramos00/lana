const { CONFIG, getPixForCtx, moneyBRL } = require('../config');
const veltrax = require('../../veltrax');

function findOfferById(offerId) {
  const id = String(offerId || '').trim();
  if (!id) return null;

  const sets = CONFIG.offerSets || {};
  for (const [setName, arr] of Object.entries(sets)) {
    const list = Array.isArray(arr) ? arr : [];
    for (const o of list) {
      if (o && String(o.id) === id) return { ...o, offerSet: setName };
    }
  }
  return null;
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

function normalizePhone(v) {
  const s = String(v || '').replace(/\D/g, '');
  return s || null;
}

function buildClientCallbackUrl() {
  const base = String(global.veltraxConfig?.callback_base_url || '').trim().replace(/\/+$/, '');
  const path = String(global.veltraxConfig?.webhook_path || '/webhook/veltrax').trim() || '/webhook/veltrax';
  if (!base) return null;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

module.exports = async function enviar_pix(ctx) {
  const wa_id = String(ctx?.wa_id || ctx?.waId || '').trim();
  const fase = String(ctx?.agent?.proxima_fase || '').trim();
  const offer_id = pickOfferId(ctx);

  // 1) resolve valor: offer_id (se existir) > fallback por fase
  const offer = offer_id ? findOfferById(offer_id) : null;
  const amount = offer && Number.isFinite(Number(offer.preco))
    ? Number(offer.preco)
    : Number(getPixForCtx(ctx).valor);

  const amountFmt = moneyBRL(amount);

  // 2) payer: se Veltrax exigir, precisa vir do usuário (não inventar CPF/email)
  const payer_name =
    String(ctx?.lead?.nome || ctx?.agent?.nome || 'Cliente').trim() || 'Cliente';

  const payer_email =
    String(ctx?.lead?.email || ctx?.agent?.payer_email || ctx?.agent?.email || '').trim() || null;

  const payer_document =
    String(ctx?.lead?.cpf || ctx?.agent?.payer_document || ctx?.agent?.cpf || '').replace(/\D/g, '') || null;

  const payer_phone =
    normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id);

  if (!payer_document || !payer_email) {
    await ctx.sendText(`Pra gerar o Pix, preciso de 2 dados.`, { reply_to_wamid: ctx.replyToWamid });
    await ctx.delay();
    if (!payer_document) {
      await ctx.sendText(`Me manda seu CPF (só números).`, { reply_to_wamid: ctx.replyToWamid });
      await ctx.delay();
    }
    if (!payer_email) {
      await ctx.sendText(`Me manda seu e-mail.`, { reply_to_wamid: ctx.replyToWamid });
    }
    return { ok: false, reason: 'missing-payer', need: { cpf: !payer_document, email: !payer_email } };
  }

  // 3) callback url
  const clientCallbackUrl = buildClientCallbackUrl();
  if (!clientCallbackUrl) {
    await ctx.sendText(`Config de pagamento incompleta (callback URL).`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'missing-callback-base-url' };
  }

  // 4) external_id único por tentativa (pra poder recriar se expirar)
  // tenta guardar tentativas no ctx.agent (lead store)
  const prevAttempt = Number(ctx?.agent?.veltrax_attempt || 0);
  const attempt = Number.isFinite(prevAttempt) ? (prevAttempt + 1) : 1;
  if (ctx?.agent) ctx.agent.veltrax_attempt = attempt;

  const extKey = offer_id || (fase || 'fase');
  const external_id = `ord_${wa_id}_${extKey}_r${attempt}`;

  // 5) cria depósito na Veltrax
  let data;
  try {
    data = await veltrax.createDeposit({
      amount,
      external_id,
      clientCallbackUrl,
      payer: {
        name: payer_name,
        email: payer_email,
        document: payer_document,
        phone: payer_phone || undefined,
      },
    });
  } catch (e) {
    await ctx.sendText(`Deu erro ao gerar o Pix. Tenta de novo.`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'veltrax-error', message: e?.message };
  }

  const transaction_id = data?.qrCodeResponse?.transactionId || null;
  const status = String(data?.qrCodeResponse?.status || 'PENDING');
  const qrcode = data?.qrCodeResponse?.qrcode || null;

  // salva no lead pra você conseguir bater no webhook depois (mínimo)
  if (ctx?.agent) {
    ctx.agent.veltrax_external_id = external_id;
    ctx.agent.veltrax_transaction_id = transaction_id;
    ctx.agent.veltrax_status = status;
    ctx.agent.offer_id = offer_id || ctx.agent.offer_id || null;
  }

  // 6) mensagens
  await ctx.sendText(`Segue o Pix pra confirmar:`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();

  if (offer?.titulo) {
    await ctx.sendText(`Produto: ${offer.titulo}`, { reply_to_wamid: ctx.replyToWamid });
    await ctx.delay();
  }

  await ctx.sendText(`Valor: ${amountFmt}`, { reply_to_wamid: ctx.replyToWamid });
  await ctx.delay();

  if (qrcode) {
    await ctx.sendText(`Copia e cola:`, { reply_to_wamid: ctx.replyToWamid });
    await ctx.delay();
    await ctx.sendText(qrcode, { reply_to_wamid: ctx.replyToWamid });
  } else {
    await ctx.sendText(`Não veio o código Pix. Vou precisar gerar de novo.`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'missing-qrcode', external_id, transaction_id, status };
  }

  if (CONFIG?.pix?.mensagemExtra) {
    await ctx.delay();
    await ctx.sendText(CONFIG.pix.mensagemExtra, { reply_to_wamid: ctx.replyToWamid });
  }

  return {
    ok: true,
    provider: 'veltrax',
    external_id,
    transaction_id,
    status,
    offer_id: offer_id || null,
    amount,
  };
};

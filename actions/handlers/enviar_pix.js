// actions/handlers/enviar_pix.js
const { CONFIG, getPixForCtx } = require('../config');
const veltrax = require('../../veltrax');

function moneyBRL(n) {
  const v = Number(n || 0);
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

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
  const base =
    String(
      global.veltraxConfig?.callback_base_url ||
      global.botSettings?.veltrax_callback_base_url ||
      ''
    ).trim().replace(/\/+$/, '');

  const path =
    String(
      global.veltraxConfig?.webhook_path ||
      global.botSettings?.veltrax_webhook_path ||
      '/webhook/veltrax'
    ).trim() || '/webhook/veltrax';

  if (!base) return null;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s || !s.includes('@')) return null;
  const [u, d] = s.split('@');
  return `${(u || '').slice(0, 2)}***@${d}`;
}

module.exports = async function enviar_pix(ctx) {
  const wa_id = String(ctx?.wa_id || ctx?.waId || '').trim();
  const fase = String(ctx?.agent?.proxima_fase || '').trim();
  const offer_id = pickOfferId(ctx);

  const offer = offer_id ? findOfferById(offer_id) : null;
  const amount = offer && Number.isFinite(Number(offer.preco))
    ? Number(offer.preco)
    : Number(getPixForCtx(ctx).valor);

  const amountFmt = moneyBRL(amount);

  // payer fixo (modo teste)
  const payer_name = String('Cliente').trim();
  const payer_email = String('cliente@teste.com').trim() || null;
  const payer_document = String('50728383829').replace(/\D/g, '') || null;
  const payer_phone = normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id);

  // callback url
  const clientCallbackUrl = buildClientCallbackUrl();
  if (!clientCallbackUrl) {
    console.error('[VELTRAX][CFG][MISSING_CALLBACK]', {
      wa_id,
      base_from_settings: global.botSettings?.veltrax_callback_base_url || null,
      path_from_settings: global.botSettings?.veltrax_webhook_path || null,
      base_from_global: global.veltraxConfig?.callback_base_url || null,
      path_from_global: global.veltraxConfig?.webhook_path || null,
    });

    await ctx.sendText(`Config de pagamento incompleta (callback URL).`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'missing-callback-base-url' };
  }

  // external_id único por tentativa
  const prevAttempt = Number(ctx?.agent?.veltrax_attempt || 0);
  const attempt = Number.isFinite(prevAttempt) ? (prevAttempt + 1) : 1;
  if (ctx?.agent) ctx.agent.veltrax_attempt = attempt;

  const extKey = offer_id || (fase || 'fase');
  let external_id = `ord_${wa_id}_${extKey}_r${attempt}`;

  // cria depósito (logs + retry 409)
  let data = null;
  let lastErr = null;

  const safePayerForLog = {
    name: payer_name,
    email: maskEmail(payer_email),
    document_last4: payer_document ? payer_document.slice(-4) : null,
    phone_last4: payer_phone ? String(payer_phone).slice(-4) : null,
  };

  const mkPayload = (extId) => ({
    amount,
    external_id: extId,
    clientCallbackUrl,
    payer: {
      name: payer_name,
      email: payer_email,
      document: payer_document,
      phone: payer_phone || undefined,
    },
  });

  for (let i = 0; i < 2; i++) {
    const extId = (i === 0) ? external_id : `${external_id}_retry${Date.now()}`;
    const payload = mkPayload(extId);

    try {
      data = await veltrax.createDeposit(payload);
      external_id = extId;

      console.log('[VELTRAX][DEPOSIT][OK]', {
        wa_id,
        offer_id,
        fase,
        amount,
        external_id,
        callback: clientCallbackUrl,
      });

      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;

      const httpStatus = e?.http_status || null;
      const reqId = e?.request_id || null;

      console.error('[VELTRAX][DEPOSIT][ERROR]', {
        wa_id,
        offer_id,
        fase,
        amount,
        external_id: extId,
        callback: clientCallbackUrl,
        payer: safePayerForLog,

        code: e?.code || null,
        http_status: httpStatus,
        request_id: reqId,

        message: e?.message || String(e),
        response_data: e?.response_data || null,
        meta: e?.meta || null,
      });

      // retry só pra 409 (conflito)
      if (httpStatus === 409 && i === 0) {
        console.warn('[VELTRAX][DEPOSIT][RETRY_409]', { old_external_id: extId });
        continue;
      }

      break;
    }
  }

  if (!data) {
    const httpStatus = lastErr?.http_status || null;

    // mensagem pro usuário
    if (httpStatus === 409) {
      await ctx.sendText(`Deu conflito ao gerar o Pix (pedido duplicado). Vou gerar outro. Tenta de novo agora.`, { reply_to_wamid: ctx.replyToWamid });
    } else if (lastErr?.code === 'VELTRAX_CONFIG') {
      await ctx.sendText(`Config da Veltrax incompleta (client_id/client_secret).`, { reply_to_wamid: ctx.replyToWamid });
    } else {
      await ctx.sendText(`Deu erro ao gerar o Pix. Tenta de novo.`, { reply_to_wamid: ctx.replyToWamid });
    }

    return {
      ok: false,
      reason: 'veltrax-error',
      code: lastErr?.code || null,
      http_status: httpStatus,
      request_id: lastErr?.request_id || null,
      message: lastErr?.message || null,
      response_data: lastErr?.response_data || null,
      meta: lastErr?.meta || null,
    };
  }

  const transaction_id = data?.qrCodeResponse?.transactionId || null;
  const status = String(data?.qrCodeResponse?.status || 'PENDING');
  const qrcode = data?.qrCodeResponse?.qrcode || null;

  // salva no lead
  if (ctx?.agent) {
    ctx.agent.veltrax_external_id = external_id;
    ctx.agent.veltrax_transaction_id = transaction_id;
    ctx.agent.veltrax_status = status;
    ctx.agent.offer_id = offer_id || ctx.agent.offer_id || null;
  }

  // mensagens
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

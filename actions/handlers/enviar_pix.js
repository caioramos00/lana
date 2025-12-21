'use strict';

const { CONFIG, getPixForCtx } = require('../config');

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

module.exports = async function enviar_pix(ctx) {
  const wa_id = String(ctx?.wa_id || ctx?.waId || '').trim();
  const fase = String(ctx?.agent?.proxima_fase || '').trim();
  const offer_id = pickOfferId(ctx);

  const offer = offer_id ? findOfferById(offer_id) : null;

  const amount =
    offer && Number.isFinite(Number(offer.preco))
      ? Number(offer.preco)
      : Number(getPixForCtx(ctx).valor);

  const amountFmt = moneyBRL(amount);

  // payer (você está em modo teste; em produção, colete corretamente)
  const payer = {
    name: 'Cliente',
    email: 'cliente@teste.com',
    document: '50728383829',
    phone: normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id),
  };

  if (!ctx?.payments?.createPixCharge) {
    await ctx.sendText('Config de pagamento incompleta (payments module).', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return { ok: false, reason: 'missing-payments-module' };
  }

  const extKey = offer_id || (fase || 'fase');

  const created = await ctx.payments.createPixCharge({
    ctx,
    wa_id,
    offer_id,
    offer_title: offer?.titulo || 'Pagamento',
    amount,
    extKey,
    payer,
    meta: {
      fase,
      offer, // ajuda o módulo a escolher gateway se você tiver offer.gateway
      product_name: offer?.titulo || null,
      offer_title: offer?.titulo || null,
    },
  });

  if (!created?.ok) {
    // motivos mais úteis
    if (created?.reason === 'missing-callback-url') {
      await ctx.sendText('Config de pagamento incompleta (callback URL).', {
        reply_to_wamid: ctx.replyToWamid,
      });
      return created;
    }

    await ctx.sendText('Deu erro ao gerar o Pix. Tenta de novo.', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return created;
  }

  const { provider, external_id, transaction_id, status, qrcode } = created;

  // salva no agent
  if (ctx?.agent) {
    ctx.agent.pix_provider = provider;
    ctx.agent.pix_external_id = external_id;
    ctx.agent.pix_transaction_id = transaction_id;
    ctx.agent.pix_status = status;
    ctx.agent.offer_id = offer_id || ctx.agent.offer_id || null;
  }

  // mensagens
  await ctx.sendText(`Segue o Pix pra confirmar:\nValor: ${amountFmt}\nCopia e cola:`, {
    reply_to_wamid: ctx.replyToWamid,
  });
  await ctx.delay();

  if (offer?.titulo) {
    await ctx.sendText(`Produto: ${offer.titulo}`, {
      reply_to_wamid: ctx.replyToWamid,
    });
    await ctx.delay();
  }

  if (qrcode) {
    await ctx.sendText(String(qrcode), { reply_to_wamid: ctx.replyToWamid });
  } else {
    await ctx.sendText('Não veio o código Pix. Vou precisar gerar de novo.', {
      reply_to_wamid: ctx.replyToWamid,
    });
    return {
      ok: false,
      reason: 'missing-qrcode',
      provider,
      external_id,
      transaction_id,
      status,
    };
  }

  if (CONFIG?.pix?.mensagemExtra) {
    await ctx.delay();
    await ctx.sendText(CONFIG.pix.mensagemExtra, { reply_to_wamid: ctx.replyToWamid });
  }

  return {
    ok: true,
    provider,
    external_id,
    transaction_id,
    status,
    offer_id: offer_id || null,
    amount,
  };
};

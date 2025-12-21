const crypto = require('crypto');
const { CONFIG, getPixForCtx } = require('../config');
const pix = require('../../payments/pix');
const utmify = require('../../payments/utmify');

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

function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s || !s.includes('@')) return null;
  const [u, d] = s.split('@');
  return `${(u || '').slice(0, 2)}***@${d}`;
}

function sanitizeKey(v, maxLen = 28) {
  const s = String(v || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'fase';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function makeExternalId({ wa_id, extKey }) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(10).toString('hex');
  const key = sanitizeKey(extKey, 28);
  const wa = String(wa_id || '').replace(/\D/g, '').slice(-18) || 'wa';
  return `ord_${wa}_${key}_${ts}_${rand}`;
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

  // payer (você já está em modo teste; em produção, colete certo)
  const payer_name = String('Cliente').trim();
  const payer_email = String('cliente@teste.com').trim() || null;
  const payer_document = String('50728383829').replace(/\D/g, '') || null;
  const payer_phone = normalizePhone(ctx?.lead?.phone || ctx?.agent?.phone || wa_id);

  const provider = pix.pickProviderFromCtx(ctx, { offer });

  const clientCallbackUrl = pix.buildCallbackUrl(provider);

  // ✅ só exige callback se o provider realmente precisar (ex.: veltrax)
  if (provider === 'veltrax' && !clientCallbackUrl) {
    console.error('[PIX][CFG][MISSING_CALLBACK]', { wa_id, provider });
    await ctx.sendText(`Config de pagamento incompleta (callback URL).`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'missing-callback-base-url', provider };
  }

  const extKey = offer_id || (fase || 'fase');

  let created = null;
  let lastErr = null;
  let external_id = null;

  const safePayerForLog = {
    name: payer_name,
    email: maskEmail(payer_email),
    document_last4: payer_document ? payer_document.slice(-4) : null,
    phone_last4: payer_phone ? String(payer_phone).slice(-4) : null,
  };

  for (let i = 0; i < 2; i++) {
    const extId = makeExternalId({ wa_id, extKey });
    try {
      created = await pix.createPix(provider, {
        amount,
        external_id: extId,
        callbackUrl: clientCallbackUrl,
        payer: {
          name: payer_name,
          email: payer_email,
          document: payer_document,
          phone: payer_phone,
        },
        meta: { wa_id, offer_id, fase, product_name: offer?.titulo || null },
      });
      external_id = extId;
      lastErr = null;

      console.log('[PIX][CREATE][OK]', {
        wa_id,
        provider,
        offer_id,
        fase,
        amount,
        external_id,
        transaction_id: created?.transaction_id || null,
        callback: clientCallbackUrl,
      });

      break;
    } catch (e) {
      lastErr = e;
      console.error('[PIX][CREATE][ERROR]', {
        wa_id,
        provider,
        offer_id,
        fase,
        amount,
        external_id: extId,
        callback: clientCallbackUrl,
        payer: safePayerForLog,
        code: e?.code || null,
        http_status: e?.http_status || null,
        request_id: e?.request_id || null,
        message: e?.message || String(e),
        response_data: e?.response_data || null,
        meta: e?.meta || null,
      });

      // retry 409 (se existir)
      if (e?.http_status === 409 && i === 0) continue;
      break;
    }
  }

  if (!created) {
    await ctx.sendText(`Deu erro ao gerar o Pix. Tenta de novo.`, { reply_to_wamid: ctx.replyToWamid });
    return {
      ok: false,
      reason: 'pix-create-error',
      provider,
      code: lastErr?.code || null,
      http_status: lastErr?.http_status || null,
      request_id: lastErr?.request_id || null,
      message: lastErr?.message || null,
      response_data: lastErr?.response_data || null,
      meta: lastErr?.meta || null,
    };
  }

  const transaction_id = created?.transaction_id || null;
  const status = String(created?.status || 'PENDING');
  const qrcode = created?.qrcode || null;

  // salva no lead
  if (ctx?.agent) {
    ctx.agent.pix_provider = provider;
    ctx.agent.pix_external_id = external_id;
    ctx.agent.pix_transaction_id = transaction_id;
    ctx.agent.pix_status = status;
    ctx.agent.offer_id = offer_id || ctx.agent.offer_id || null;
  }

  // salva no DB (tabela genérica)
  let row = null;
  try {
    if (ctx?.db?.createPixDepositRow) {
      row = await ctx.db.createPixDepositRow({
        provider,
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
        qrcode,
        raw_create_response: created?.raw || null,
      });
    }
  } catch (e) {
    console.log('[PIX][DB][WARN]', { message: e?.message });
  }

  // Send to Utmify waiting_payment
  utmify.sendToUtmify('waiting_payment', {
    external_id,
    amount,
    payer_name,
    payer_email,
    payer_phone,
    payer_document,
    offer_id,
    offer_title: offer?.titulo || 'Pagamento',
    createdAt: row?.created_at.getTime() || Date.now(),
  });

  // mensagens
  await ctx.sendText(
    `Segue o Pix pra confirmar:\nValor: ${amountFmt}\nCopia e cola:`,
    { reply_to_wamid: ctx.replyToWamid }
  );
  await ctx.delay();

  if (offer?.titulo) {
    await ctx.sendText(`Produto: ${offer.titulo}`, { reply_to_wamid: ctx.replyToWamid });
    await ctx.delay();
  }

  if (qrcode) {
    await ctx.sendText(String(qrcode), { reply_to_wamid: ctx.replyToWamid });
  } else {
    await ctx.sendText(`Não veio o código Pix. Vou precisar gerar de novo.`, { reply_to_wamid: ctx.replyToWamid });
    return { ok: false, reason: 'missing-qrcode', provider, external_id, transaction_id, status };
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

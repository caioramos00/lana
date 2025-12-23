function moneyBRL(n) {
  const v = Number(n || 0);
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

function parseBRL(n) {
  if (n == null) return null;

  // number direto
  if (typeof n === 'number') return Number.isFinite(n) ? n : null;

  // string tipo "49,90" / "R$ 49,90" / "49.90"
  const s = String(n)
    .trim()
    .replace(/\s/g, '')
    .replace('R$', '')
    .replace(/\./g, '')       // remove separador de milhar
    .replace(',', '.');       // decimal BR -> US

  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const CONFIG = {
  pix: {
    chave: 'SUA_CHAVE_PIX_AQUI',
    recebedor: 'SEU_NOME/EMPRESA',

    // ⚠️ IMPORTANTE:
    // Removemos PAGAMENTO daqui pra não "forçar" 9,90.
    // POS_PAGAMENTO continua 0.
    valorPorFase: { POS_PAGAMENTO: 0 },

    // fallback se não vier offer/valor do agent
    valorDefault: 3.90,

    mensagemExtra: 'assim que confirmar, eu já libero o seu acesso aqui. se der algum problema aí, você me fala amor',
  },

  links: { acesso: 'https://seu-link-de-acesso-aqui' },

  offerSets: {
    VIP: [
      { id: 'vip_basic', titulo: 'Plano Básico', preco: 2.90, resumo: 'Acesso imediato + suporte.' },
      { id: 'vip_pro', titulo: 'Plano Pro', preco: 49.90, resumo: 'Tudo do Básico + bônus.' },
    ],

    FOTOS: [
      { id: 'foto_individual', titulo: 'Foto individual', preco: 9.90, resumo: 'Uma foto conforme pedido.' },
      { id: 'pack_fotos', titulo: 'Pack de fotos', preco: 29.90, resumo: 'Pacote com várias fotos.' },
      { id: 'fotos_fetiche', titulo: 'Fotos de fetiche', preco: 39.90, resumo: 'Conteúdo temático sob pedido.' },
    ],

    VIDEOS: [
      { id: 'video_individual', titulo: 'Vídeo individual', preco: 1.90, resumo: 'Vídeo curto sob pedido.' },
      { id: 'pack_videos', titulo: 'Pack de vídeos', preco: 59.90, resumo: 'Pacote com vários vídeos.' },
      { id: 'videos_fetiche', titulo: 'Vídeos de fetiche', preco: 79.90, resumo: 'Conteúdo temático sob pedido.' },
    ],

    AUDIOS: [
      { id: 'audio_personalizado', titulo: 'Áudio personalizado', preco: 9.90, resumo: 'Áudio sob pedido.' },
      { id: 'audio_gemendo', titulo: 'Áudio especial', preco: 14.90, resumo: 'Áudio em clima mais íntimo.' },
    ],

    AO_VIVO: [
      { id: 'chamada_video', titulo: 'Chamada de vídeo', preco: 49.90, resumo: 'Ao vivo em horário combinado.' },
      { id: 'chamada_audio', titulo: 'Chamada de áudio', preco: 29.90, resumo: 'Ao vivo em horário combinado.' },
    ],

    ASSINATURAS: [
      { id: 'assin_semanal', titulo: 'Assinatura semanal', preco: 29.90, resumo: 'Acesso por 7 dias.' },
      { id: 'assin_mensal', titulo: 'Assinatura mensal', preco: 59.90, resumo: 'Acesso por 30 dias.' },
      { id: 'assin_anual', titulo: 'Assinatura anual', preco: 199.90, resumo: 'Acesso por 12 meses.' },
      { id: 'vitalicio', titulo: 'Acesso vitalício', preco: 399.90, resumo: 'Acesso sem expiração.' },
      { id: 'grupo_whats', titulo: 'Grupo privado no WhatsApp', preco: 49.90, resumo: 'Acesso ao grupo privado.' },
    ],

    UPSELLS: [
      { id: 'mimo', titulo: 'Mimo', preco: 15.00, resumo: 'Apoio/agrado (lanche, academia etc.).' },
    ],
  },

  intentToOfferSet: {
    INTERESSE_VIP: 'VIP',

    INTERESSE_FOTO_INDIVIDUAL: 'FOTOS',
    INTERESSE_PACK_FOTOS: 'FOTOS',
    INTERESSE_FOTO_FETICHE: 'FOTOS',

    INTERESSE_VIDEO_INDIVIDUAL: 'VIDEOS',
    INTERESSE_PACK_VIDEOS: 'VIDEOS',
    INTERESSE_VIDEO_FETICHE: 'VIDEOS',

    INTERESSE_AUDIO_PERSONALIZADO: 'AUDIOS',
    INTERESSE_AUDIO_GEMENDO: 'AUDIOS',

    INTERESSE_VIDEOCHAMADA: 'AO_VIVO',
    INTERESSE_AUDIOCHAMADA: 'AO_VIVO',

    INTERESSE_ASSINATURA: 'ASSINATURAS',
    INTERESSE_ASSINATURA_SEMANAL: 'ASSINATURAS',
    INTERESSE_ASSINATURA_MENSAL: 'ASSINATURAS',
    INTERESSE_ASSINATURA_ANUAL: 'ASSINATURAS',
    INTERESSE_ACESSO_VITALICIO: 'ASSINATURAS',
    INTERESSE_GRUPO_WHATSAPP_PRIVADO: 'ASSINATURAS',

    INTERESSE_MIMO: 'UPSELLS',
  },

  media: { videoUrl: 'https://seu-video-hosted-aqui.mp4' },
};

let _offerIndex = null;

function buildOfferIndex() {
  const idx = {};
  const sets = CONFIG.offerSets || {};
  for (const [setName, arr] of Object.entries(sets)) {
    const list = Array.isArray(arr) ? arr : [];
    for (const o of list) {
      if (o?.id) idx[String(o.id)] = { ...o, offerSet: setName };
    }
  }
  return idx;
}

function getOfferById(offerId) {
  const id = String(offerId || '').trim();
  if (!id) return null;
  if (!_offerIndex) _offerIndex = buildOfferIndex();
  return _offerIndex[id] || null;
}

function listAllOffers() {
  if (!_offerIndex) _offerIndex = buildOfferIndex();
  return Object.values(_offerIndex);
}

// 👇 AQUI É O PONTO PRINCIPAL
function getPixForCtx(ctx) {
  const agent = ctx?.agent || {};
  const fase = String(agent?.proxima_fase || '').trim();

  // 1) se o prompt mandar o valor final, ele ganha
  const valorDoAgent =
    parseBRL(agent?.valor_pix) ??
    parseBRL(agent?.valor_final) ??
    parseBRL(agent?.preco_final) ??
    parseBRL(agent?.valor);

  // 2) se o prompt mandar o id da oferta, usamos o catálogo
  const offerId =
    (agent?.offer_id || agent?.oferta_id || agent?.ofertaId || agent?.offerId || '').toString().trim();

  const offer = offerId ? getOfferById(offerId) : null;
  const valorDaOffer = offer ? parseBRL(offer.preco) : null;

  // 3) fallback antigo (fase/default)
  const fallbackPorFase =
    (fase && CONFIG.pix.valorPorFase[fase] != null) ? CONFIG.pix.valorPorFase[fase] : null;

  // valor final
  const v =
    (valorDoAgent != null ? valorDoAgent :
      (valorDaOffer != null ? valorDaOffer :
        (fallbackPorFase != null ? fallbackPorFase : CONFIG.pix.valorDefault)));

  return {
    ...CONFIG.pix,
    valor: v,
    valorFmt: moneyBRL(v),
    offerId: offer?.id || (offerId || null),
    offerTitulo: offer?.titulo || null,
    fase: fase || null,
  };
}

module.exports = { CONFIG, getPixForCtx, moneyBRL, getOfferById, listAllOffers, parseBRL };

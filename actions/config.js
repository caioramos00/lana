function moneyBRL(n) {
  const v = Number(n || 0);
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

// Exemplo: você define as regras aqui.
// Pode evoluir isso depois pra DB sem mudar o runner.
const CONFIG = {
  pix: {
    // chave + recebedor fixos
    chave: 'SUA_CHAVE_PIX_AQUI',
    recebedor: 'SEU_NOME/EMPRESA',

    // valor escolhido pelo BACKEND (não pelo prompt)
    valorPorFase: {
      PAGAMENTO: 19.90,
      POS_PAGAMENTO: 0,
    },
    valorDefault: 19.90,

    mensagemExtra: 'Assim que confirmar, eu já libero o acesso aqui.',
  },

  links: {
    acesso: 'https://seu-link-de-acesso-aqui',
  },

  ofertas: [
    { id: 'basic', titulo: 'Plano Básico', preco: 19.90, resumo: 'Acesso imediato + suporte.' },
    { id: 'pro', titulo: 'Plano Pro', preco: 49.90, resumo: 'Tudo do Básico + bônus.' },
  ],

  media: {
    videoUrl: 'https://seu-video-hosted-aqui.mp4',
  },
};

function getPixForCtx(ctx) {
  const fase = String(ctx?.agent?.proxima_fase || '').trim();
  const v = (fase && CONFIG.pix.valorPorFase[fase] != null)
    ? CONFIG.pix.valorPorFase[fase]
    : CONFIG.pix.valorDefault;

  return {
    ...CONFIG.pix,
    valor: v,
    valorFmt: moneyBRL(v),
  };
}

module.exports = { CONFIG, getPixForCtx };

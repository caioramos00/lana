function promptClassificaOptOut(texto) {
  return `
Você é um **CLASSIFICADOR BINÁRIO de opt-out**.

Entrada:
- Você receberá UM OU MAIS trechos de mensagens do usuário, na ordem em que chegaram, separados por " | ".
- Considere o CONJUNTO como um todo, dando PESO MAIOR às mensagens MAIS RECENTES.

Objetivo:
- Decidir se há um pedido explícito para PARAR de receber mensagens (opt-out) OU se há ACUSAÇÃO/SUSPEITA de golpe/engano/falsidade que indique rejeição hostil ao contato. Em ambos os casos → OPTOUT.

Princípios (em ordem):
1) Normalize mentalmente: minúsculas, sem acentos; ignore emojis/URLs/hashtags/ruído.
2) Pedido explícito de parar (ex.: parar, pare, para, stop, unsubscribe, remover, tirar da lista, cancelar, sair, bloquear) → OPTOUT.
3) Ameaça/denúncia/autoridades (ex.: denunciar, polícia, procon, advogado, golpe, fraude, crime, scam, spam) → OPTOUT.
4) Acusação/suspeita de ENGANO/FAKE/GOLPE mesmo sem “pare” → OPTOUT.
   - Gatilhos PT (indicativos, não exaustivos): enganar, enrolar, passar a perna, papo furado, truque, armadilha, golpe, picaretagem, fraude, piramide, esquema, treta, fake, fakezada, falso, mentira, forjado, “isso não cola”, enganação, “já vi isso antes” (quando implica golpe), “isso é fake?”, “tá tentando me enganar?”.
   - EN: scam, fraud, fake, phishing, shady, trick, rip-off, bogus.
   - ES: estafa, fraude, timo, engaño, trampa, falso.
5) Recusa momentânea, dúvida neutra ou curiosidade (ex.: “agora não”, “depois vejo”, “é real?”, “tem garantia?”) SEM acusação/ameaça → CONTINUAR.
6) Conflito: prevalece a rejeição/ameaça/acusação MAIS RECENTE → OPTOUT.
7) Segurança primeiro: EM CASO DE DÚVIDA real, devolva OPTOUT.

FORMATO DE SAÍDA (obrigatório, somente JSON):
{"label":"OPTOUT"} ou {"label":"CONTINUAR"}

Exemplos rápidos (→ saída):
"pare" → {"label":"OPTOUT"}
"stop" → {"label":"OPTOUT"}
"me tira da lista" → {"label":"OPTOUT"}
"isso é golpe" → {"label":"OPTOUT"}
"já vi isso antes, papo furado" → {"label":"OPTOUT"}
"tá tentando me enganar?" → {"label":"OPTOUT"}
"isso não é fakezada não?" → {"label":"OPTOUT"}
"agora não" → {"label":"CONTINUAR"}
"depois eu vejo" → {"label":"CONTINUAR"}

Mensagens do usuário (separadas por " | "):
${texto}

Saída apenas em JSON:`;
}

function promptClassificaReoptin(texto) {
  return `
Tarefa: Dizer se o usuário está RETOMANDO/ACEITANDO continuar a conversa (re-opt-in).

Entrada:
- Você receberá ATÉ 3 mensagens, separadas por " | ", na ordem em que chegaram.
- Dê peso MAIOR à MENSAGEM MAIS RECENTE.

Rótulos:
- optin      → há intenção CLARA de continuar/retomar/aceitar (ex.: "bora", "pode continuar", "pode mandar", "segue", "vamos", "manda", "ok pode mandar", "pode falar", "pode prosseguir", "quero sim", "sim" quando indica aceite, "fechou", "tô dentro", "topo", "aceito", "retoma", "prossegue", "pode enviar", "continua", etc.). Considere variações/gírias/erros.
- nao_optin  → qualquer outra coisa (neutra, dúvida, recusa, silêncio). "ok", "blz", "entendi" SOZINHOS não contam como aceite.

Regras:
1) Avalie o conjunto; prevalece a intenção da ÚLTIMA mensagem quando houver conflito.
2) Seja conservador: só marque optin se estiver CLARO.
3) Responda SOMENTE em JSON válido.

FORMATO DE SAÍDA:
{"label":"optin"} ou {"label":"nao_optin"}

Mensagens do usuário (separadas por " | "):
${texto}

Saída apenas em JSON:`;
}

module.exports = { promptClassificaOptOut, promptClassificaReoptin };

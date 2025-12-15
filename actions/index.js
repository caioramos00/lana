const { createActionRunner } = require('./action-runner');

const enviar_audio = require('./handlers/enviar_audio');
const enviar_pix = require('./handlers/enviar_pix');
const enviar_link_acesso = require('./handlers/enviar_link_acesso');

// Você pode ir adicionando handlers aqui conforme for criando novos arquivos.
function createActions({ senders, lead, db, aiLog }) {
  const runner = createActionRunner({
    aiLog,
    handlers: [
      enviar_pix,
      enviar_link_acesso,
      enviar_audio,
      // mostrar_ofertas, enviar_video, etc...
    ],
  });

  async function run(agent, ctx) {
    const acoes = agent?.acoes || {};
    return runner.runAll(acoes, ctx);
  }

  return { run };
}

module.exports = { createActions };

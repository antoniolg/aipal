const { AGENT_CODEX_APP } = require('../agents');

function registerSendToCodexCommand(options) {
  const {
    bot,
    getSendToCodexSourceThread,
    getTopicId,
    replyWithError,
    sendToCodexPicker,
  } = options;

  bot.command('send_to_codex', async (ctx) => {
    try {
      const sourceThread = await getSendToCodexSourceThread({
        agentId: AGENT_CODEX_APP,
        chatId: ctx.chat.id,
        topicId: getTopicId(ctx),
      });
      if (!sourceThread?.threadId) {
        await ctx.reply(
          'Este topic no tiene ahora mismo una sesion de codex-app de aipal para enviar a Codex App.'
        );
        return;
      }
      await sendToCodexPicker(ctx, sourceThread);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No se pudo preparar el envio a Codex App.', err);
    }
  });
}

module.exports = {
  registerSendToCodexCommand,
};

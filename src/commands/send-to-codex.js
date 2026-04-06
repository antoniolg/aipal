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
          'This topic does not currently have an aipal codex-app session to send to Codex App.'
        );
        return;
      }
      await sendToCodexPicker(ctx, sourceThread);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to prepare the Codex App export.', err);
    }
  });
}

module.exports = {
  registerSendToCodexCommand,
};

const { AGENT_CODEX_APP } = require('../agents');

function registerResumeCommand(options) {
  const {
    bot,
    getCodexAppThreadId,
    getAgentLabel,
    getTopicId,
    listResumeThreads,
    readResumeThreadState,
    replyWithError,
    resolveEffectiveAgentId,
    sendResumeThreadPicker,
  } = options;

  bot.command('resume', async (ctx) => {
    const topicId = getTopicId(ctx);
    const query = String(
      ctx.message.text.replace(/^\/resume(?:@[^\s]+)?/i, '')
    ).trim();
    const effectiveAgentId = resolveEffectiveAgentId(ctx.chat.id, topicId);

    try {
      const threads = await listResumeThreads({
        agentId: AGENT_CODEX_APP,
        query,
      });
      if (!Array.isArray(threads) || threads.length === 0) {
        await ctx.reply(
          query
            ? `No se encontraron sesiones de codex-app para "${query}".`
            : 'No se encontraron sesiones previas de codex-app.'
        );
        return;
      }

      const currentBinding = getCodexAppThreadId(
        ctx.chat.id,
        topicId
      );

      await sendResumeThreadPicker(ctx, {
        currentBinding,
        effectiveAgentLabel: getAgentLabel(effectiveAgentId),
        query,
        threads,
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No se pudieron listar las sesiones de codex-app.', err);
    }
  });

  bot.command('status', async (ctx) => {
    const topicId = getTopicId(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(ctx.chat.id, topicId);
    try {
      const status = await readResumeThreadState({
        chatId: ctx.chat.id,
        effectiveAgentId,
        topicId,
      });
      await ctx.reply(status, {
        disable_web_page_preview: true,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No se pudo leer el estado del topic.', err);
    }
  });
}

module.exports = {
  registerResumeCommand,
};

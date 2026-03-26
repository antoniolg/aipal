function registerStopCommand(options) {
  const {
    bot,
    getAgentLabel,
    getTopicId,
    replyWithError,
    resolveEffectiveAgentId,
    stopActiveRun,
  } = options;

  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const agentId = resolveEffectiveAgentId(chatId, topicId);

    try {
      const result = await stopActiveRun(chatId, topicId, agentId);
      if (result.status === 'stopping') {
        await ctx.reply(`Stopping ${getAgentLabel(agentId)}...`);
        return;
      }
      if (result.status === 'queued') {
        await ctx.reply(
          `Stopping ${getAgentLabel(agentId)} as soon as it finishes starting...`
        );
        return;
      }
      if (result.status === 'unsupported') {
        await ctx.reply(`${getAgentLabel(agentId)} does not support /stop right now.`);
        return;
      }
      await ctx.reply(`No active ${getAgentLabel(agentId)} run in this topic.`);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to stop the active run.', err);
    }
  });
}

module.exports = {
  registerStopCommand,
};

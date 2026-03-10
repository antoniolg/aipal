function registerLaterCommand(options) {
  const {
    bot,
    cancelScheduledRun,
    createScheduledRun,
    extractCommandValue,
    formatScheduledRun,
    getOneShotScheduler,
    getTopicId,
    listScheduledRuns,
    loadScheduledRuns,
    replyWithError,
    resolveEffectiveAgentId,
  } = options;

  bot.command('later', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/).filter(Boolean) : [];
    const subcommand = (parts[0] || '').toLowerCase();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);

    if (!value) {
      await ctx.reply(
        'Usage: /later <ISO-8601 datetime> | <prompt>\n/later list\n/later cancel <runId>'
      );
      return;
    }

    if (subcommand === 'list') {
      try {
        const state = await loadScheduledRuns();
        const runs = listScheduledRuns(state.runs).filter(
          (run) => !['succeeded', 'dead_letter', 'cancelled'].includes(run.status)
        );
        if (!runs.length) {
          await ctx.reply('No pending one-shot schedules.');
          return;
        }
        await ctx.reply(
          ['Pending one-shot schedules:', ...runs.slice(0, 20).map((run) => `- ${formatScheduledRun(run)}`)].join('\n')
        );
      } catch (err) {
        await replyWithError(ctx, 'Failed to list one-shot schedules.', err);
      }
      return;
    }

    if (subcommand === 'cancel') {
      const runId = parts[1];
      if (!runId) {
        await ctx.reply('Usage: /later cancel <runId>');
        return;
      }
      try {
        const run = await cancelScheduledRun(runId);
        if (!run) {
          await ctx.reply(`Scheduled run "${runId}" not found.`);
          return;
        }
        await ctx.reply(`Scheduled run "${runId}" is now ${run.status}.`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to cancel one-shot schedule.', err);
      }
      return;
    }

    const separatorIndex = value.indexOf('|');
    if (separatorIndex === -1) {
      await ctx.reply('Usage: /later <ISO-8601 datetime> | <prompt>');
      return;
    }

    const runAt = value.slice(0, separatorIndex).trim();
    const prompt = value.slice(separatorIndex + 1).trim();
    if (!runAt || !prompt) {
      await ctx.reply('Usage: /later <ISO-8601 datetime> | <prompt>');
      return;
    }

    try {
      const run = await createScheduledRun({
        runAt,
        prompt,
        chatId,
        topicId,
        agent: resolveEffectiveAgentId(chatId, topicId),
        source: 'command',
      });
      const scheduler = getOneShotScheduler ? getOneShotScheduler() : null;
      if (scheduler && typeof scheduler.tick === 'function') {
        void scheduler.tick();
      }
      await ctx.reply(`Scheduled one-shot run for ${run.runAt} (id: ${run.id}).`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to create one-shot schedule.', err);
    }
  });
}

module.exports = {
  registerLaterCommand,
};

function registerRunsCommand(options) {
  const {
    bot,
    extractCommandValue,
    formatRunsMessage,
    listRecentRuns,
    loadCronJobs,
    loadCronState,
    replyWithError,
  } = options;

  bot.command('runs', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/).filter(Boolean) : [];
    let jobId = null;
    let limit = 10;

    for (const part of parts) {
      const numeric = Number.parseInt(part, 10);
      if (Number.isFinite(numeric) && String(numeric) === part) {
        limit = Math.max(1, Math.min(20, numeric));
      } else if (!jobId) {
        jobId = part;
      }
    }

    try {
      const [jobs, cronState] = await Promise.all([loadCronJobs(), loadCronState()]);
      const runs = listRecentRuns({ jobs, cronState, limit, jobId });
      await ctx.reply(formatRunsMessage(runs));
    } catch (err) {
      await replyWithError(ctx, 'Failed to read cron runs.', err);
    }
  });
}

module.exports = {
  registerRunsCommand,
};

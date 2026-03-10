function registerCronCommand(options) {
  const {
    bot,
    buildCronTriggerPayload,
    buildCronInspection,
    extractCommandValue,
    formatCronInspection,
    getCronDefaultChatId,
    getCronScheduler,
    getTopicId,
    handleCronTrigger,
    loadCronJobs,
    loadCronState,
    replyWithError,
    saveCronJobs,
  } = options;

  bot.command('cron', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/) : [];
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === 'list') {
      try {
        const jobs = await loadCronJobs();
        if (jobs.length === 0) {
          await ctx.reply('No cron jobs configured.');
          return;
        }
        const lines = jobs.map((j) => {
          const status = j.enabled ? '✅' : '❌';
          const topicLabel = j.topicId ? ` [📌 Topic ${j.topicId}]` : '';
          return `${status} ${j.id}: ${j.cron}${topicLabel}`;
        });
        await ctx.reply(`Cron jobs:\n${lines.join('\n')}`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to list cron jobs.', err);
      }
      return;
    }

    if (subcommand === 'assign') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron assign <jobId>');
        return;
      }
      const topicId = getTopicId(ctx);
      if (!topicId) {
        await ctx.reply(
          'Send this command from a topic/thread in a group to assign the cron to it.'
        );
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(
            `Cron job "${jobId}" not found. Available: ${jobs
              .map((j) => j.id)
              .join(', ')}`
          );
          return;
        }
        job.topicId = topicId;
        job.chatId = ctx.chat.id;
        await saveCronJobs(jobs);
        const scheduler = getCronScheduler();
        if (scheduler) await scheduler.reload();
        await ctx.reply(`Cron "${jobId}" assigned to this topic (${topicId}).`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to assign cron job.', err);
      }
      return;
    }

    if (subcommand === 'unassign') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron unassign <jobId>');
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(`Cron job "${jobId}" not found.`);
          return;
        }
        delete job.topicId;
        delete job.chatId;
        await saveCronJobs(jobs);
        const scheduler = getCronScheduler();
        if (scheduler) await scheduler.reload();
        await ctx.reply(`Cron "${jobId}" unassigned. Will send to default chat.`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to unassign cron job.', err);
      }
      return;
    }

    if (subcommand === 'run') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron run <jobId>');
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(
            `Cron job "${jobId}" not found. Available: ${jobs
              .map((j) => j.id)
              .join(', ')}`
          );
          return;
        }
        const payload = buildCronTriggerPayload(
          job,
          getCronDefaultChatId() || ctx.chat.id
        );
        const topicLabel = payload.options.topicId
          ? ` topic ${payload.options.topicId}`
          : '';
        const disabledLabel = job.enabled
          ? ''
          : ' (disabled in schedule, manual run forced)';
        await ctx.reply(
          `Running cron "${job.id}" now -> chat ${payload.chatId}${topicLabel}${disabledLabel}`
        );
        const result = await handleCronTrigger(
          payload.chatId,
          payload.prompt,
          payload.options
        );
        if (result && result.ok === false) {
          await ctx.reply(`Cron "${job.id}" failed.`);
          return;
        }
        await ctx.reply(`Cron "${job.id}" finished.`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to run cron job.', err);
      }
      return;
    }

    if (subcommand === 'inspect') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron inspect <jobId>');
        return;
      }
      try {
        const [jobs, cronState] = await Promise.all([loadCronJobs(), loadCronState()]);
        const job = jobs.find((item) => item.id === jobId);
        if (!job) {
          await ctx.reply(`Cron job "${jobId}" not found.`);
          return;
        }
        const inspection = buildCronInspection({ job, cronState });
        await ctx.reply(formatCronInspection(inspection));
      } catch (err) {
        await replyWithError(ctx, 'Failed to inspect cron job.', err);
      }
      return;
    }

    if (subcommand === 'reload') {
      const scheduler = getCronScheduler();
      if (scheduler) {
        const count = await scheduler.reload();
        await ctx.reply(`Cron jobs reloaded. ${count} job(s) scheduled.`);
      } else {
        await ctx.reply(
          'Cron scheduler not running. Set cronChatId in config.json first.'
        );
      }
      return;
    }

    if (subcommand === 'chatid') {
      await ctx.reply(`Your chat ID: ${ctx.chat.id}`);
      return;
    }

    await ctx.reply('Usage: /cron [list|reload|chatid|assign|unassign|run|inspect]');
  });
}

module.exports = {
  registerCronCommand,
};

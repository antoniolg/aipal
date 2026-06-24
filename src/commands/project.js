function registerProjectCommand(options) {
  const {
    bot,
    clearCodexAppThreadForTopic,
    clearProjectOverride,
    getProjectOverride,
    getTopicId,
    persistProjectOverrides,
    persistThreads,
    replyWithError,
    sendProjectPicker,
  } = options;

  bot.command('project', async (ctx) => {
    const topicId = getTopicId(ctx);
    const value = String(ctx.message?.text || '')
      .replace(/^\/project(?:@\w+)?\s*/i, '')
      .trim();

    if (value.toLowerCase() === 'reset') {
      try {
        const hadProject = clearProjectOverride(ctx.chat.id, topicId);
        clearCodexAppThreadForTopic(ctx.chat.id, topicId);
        await Promise.all([persistProjectOverrides(), persistThreads()]);
        await ctx.reply(
          hadProject
            ? 'Project cleared for this topic. The next codex-app message will use the default project cwd.'
            : 'No project was set for this topic. codex-app will use the default project cwd.'
        );
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'Failed to reset the project for this topic.', err);
      }
      return;
    }

    try {
      await sendProjectPicker(ctx, {
        currentProjectPath: getProjectOverride(ctx.chat.id, topicId),
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to load Codex App projects.', err);
    }
  });
}

module.exports = {
  registerProjectCommand,
};

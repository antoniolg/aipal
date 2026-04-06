const { AGENT_CODEX_APP } = require('../agents');

function parseResumeArgs(text) {
  const raw = String(text || '').replace(/^\/resume(?:@[^\s]+)?/i, '').trim();
  if (!raw) {
    return { includeAipal: false, query: '' };
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  const queryParts = [];
  let includeAipal = false;

  for (const part of parts) {
    if (part === '--all') {
      includeAipal = true;
      continue;
    }
    queryParts.push(part);
  }

  return {
    includeAipal,
    query: queryParts.join(' ').trim(),
  };
}

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
    const { includeAipal, query } = parseResumeArgs(ctx.message.text);
    const effectiveAgentId = resolveEffectiveAgentId(ctx.chat.id, topicId);

    try {
      const threads = await listResumeThreads({
        agentId: AGENT_CODEX_APP,
        includeAipal,
        query,
      });
      if (!Array.isArray(threads) || threads.length === 0) {
        await ctx.reply(
          query
            ? `No codex-app sessions found for "${query}".`
            : 'No previous codex-app sessions found.'
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
      await replyWithError(ctx, 'Failed to list codex-app sessions.', err);
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
      await replyWithError(ctx, 'Failed to read topic status.', err);
    }
  });
}

module.exports = {
  parseResumeArgs,
  registerResumeCommand,
};

function registerMemoryCommand(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    curateMemory,
    enqueue,
    extractCommandValue,
    getMemoryStatus,
    getThreadTail,
    memoryRetrievalLimit,
    persistMemory,
    replyWithError,
    resolveEffectiveAgentId,
    searchMemory,
    setMemoryEventsSinceCurate,
    startTyping,
    getTopicId,
  } = options;

  const KNOWN_SUBCOMMANDS = new Set(['status', 'tail', 'search', 'curate']);

  function compactMemoryText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function formatMemoryHit(hit) {
    const ts = String(hit.createdAt || '').replace('T', ' ').slice(0, 16);
    const who = hit.role === 'assistant' ? 'assistant' : 'user';
    const text = compactMemoryText(hit.text);
    const scope = hit.scope ? `${hit.scope}, ` : '';
    return `- [${ts}] (${scope}${who}) ${text}`;
  }

  function buildSearchQueryFromTail(events) {
    const snippets = [];
    for (const event of [...events].reverse()) {
      if (event.role !== 'user') continue;
      const text = compactMemoryText(event.text);
      if (!text || /^\/memory(?:@\w+)?(?:\s|$)/i.test(text)) continue;
      snippets.push(text);
      if (snippets.length >= 3) break;
    }
    return snippets.reverse().join('\n').slice(0, 2200).trim();
  }

  async function runSearch(ctx, params) {
    const {
      agentId,
      chatId,
      limit,
      query,
      threadKey,
      topicId,
    } = params;
    let resolvedQuery = compactMemoryText(query);
    if (!resolvedQuery) {
      const events = await getThreadTail(threadKey, { limit: 12 });
      resolvedQuery = buildSearchQueryFromTail(events);
    }
    if (!resolvedQuery) {
      await ctx.reply('No tengo suficiente contexto reciente para buscar memoria. Usa: /memory <query>');
      return;
    }
    const hits = await searchMemory({
      query: resolvedQuery,
      chatId,
      topicId,
      agentId,
      limit,
    });
    if (!hits.length) {
      await ctx.reply('No relevant memory found for that query.');
      return;
    }
    const lines = ['**Memoria relevante**', '', ...hits.map(formatMemoryHit)];
    await ctx.reply(lines.join('\n'));
  }

  bot.command('memory', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/).filter(Boolean) : [];
    const firstToken = (parts[0] || '').toLowerCase();
    const subcommand = KNOWN_SUBCOMMANDS.has(firstToken) ? firstToken : 'search';
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const threadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);

    if (subcommand === 'status') {
      try {
        const status = await getMemoryStatus();
        const lines = [
          `Memory file: ${status.memoryPath}`,
          `Thread files: ${status.threadFiles}`,
          `Total events: ${status.totalEvents}`,
          `Indexed events: ${status.indexedEvents}`,
          `Index path: ${status.indexPath || '(unavailable)'}`,
          `FTS enabled: ${status.indexSupportsFts ? 'yes' : 'no'}`,
          `Events today: ${status.eventsToday}`,
          `Last curated: ${status.lastCuratedAt || '(never)'}`,
        ];
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        await replyWithError(ctx, 'Failed to read memory status.', err);
      }
      return;
    }

    if (subcommand === 'tail') {
      const parsed = Number(parts[1] || 10);
      const limit = Number.isFinite(parsed)
        ? Math.max(1, Math.min(50, Math.trunc(parsed)))
        : 10;
      try {
        const events = await getThreadTail(threadKey, { limit });
        if (!events.length) {
          await ctx.reply('No memory events in this conversation yet.');
          return;
        }
        const lines = events.map((event) => {
          const ts = String(event.createdAt || '').replace('T', ' ').slice(0, 16);
          const who = event.role === 'assistant' ? 'assistant' : 'user';
          const text = String(event.text || '').replace(/\s+/g, ' ').trim();
          return `- [${ts}] ${who}: ${text}`;
        });
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        await replyWithError(ctx, 'Failed to read thread memory tail.', err);
      }
      return;
    }

    if (subcommand === 'search') {
      const explicitSearch = firstToken === 'search';
      const searchParts = explicitSearch ? parts.slice(1) : parts;
      const parsedLimit = Number(parts[parts.length - 1]);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(20, Math.trunc(parsedLimit)))
        : memoryRetrievalLimit;
      const queryParts = Number.isFinite(parsedLimit) ? searchParts.slice(0, -1) : searchParts;
      const query = queryParts.join(' ').trim();
      try {
        await runSearch(ctx, {
          query,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          threadKey,
          limit,
        });
      } catch (err) {
        await replyWithError(ctx, 'Memory search failed.', err);
      }
      return;
    }

    if (subcommand === 'curate') {
      enqueue(`${topicKey}:memory-curate`, async () => {
        const stopTyping = startTyping(ctx);
        try {
          const result = await persistMemory(() => curateMemory());
          setMemoryEventsSinceCurate(0);
          await ctx.reply(
            [
              'Memory curated.',
              `Events processed: ${result.eventsProcessed}`,
              `Thread files: ${result.threadFiles}`,
              `Output bytes: ${result.bytes}`,
              `Updated: ${result.lastCuratedAt}`,
            ].join('\n')
          );
        } catch (err) {
          await replyWithError(ctx, 'Memory curation failed.', err);
        } finally {
          stopTyping();
        }
      });
      return;
    }

    await ctx.reply('Usage: /memory [query]|status|tail [n]|search <query>|curate');
  });
}

module.exports = {
  registerMemoryCommand,
};

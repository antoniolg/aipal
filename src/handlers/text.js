function registerTextHandler(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext,
    enqueue,
    extractMemoryText,
    formatScriptContext,
    getTopicId,
    lastScriptOutputs,
    parseSlashCommand,
    replyWithError,
    replyWithResponse,
    resolveEffectiveAgentId,
    runAgentForChat,
    runScriptCommand,
    scriptManager,
    startTyping,
  } = options;

  bot.on('text', (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    const text = ctx.message.text.trim();
    if (!text) return;

    const slash = parseSlashCommand(text);
    if (slash) {
      const normalized = slash.name.toLowerCase();
      if (
        [
          'start',
          'thinking',
          'agent',
          'model',
          'memory',
          'reset',
          'cron',
          'help',
          'menu',
          'document_scripts',
        ].includes(normalized)
      ) {
        return;
      }
      enqueue(topicKey, async () => {
        const stopTyping = startTyping(ctx);
        const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
        const memoryThreadKey = buildMemoryThreadKey(
          chatId,
          topicId,
          effectiveAgentId
        );
        try {
          await captureMemoryEvent({
            threadKey: memoryThreadKey,
            chatId,
            topicId,
            agentId: effectiveAgentId,
            role: 'user',
            kind: 'command',
            text,
          });
          let scriptMeta = {};
          try {
            scriptMeta = await scriptManager.getScriptMetadata(slash.name);
          } catch (err) {
            console.error('Failed to read script metadata', err);
            scriptMeta = {};
          }
          const output = await runScriptCommand(slash.name, slash.args);
          const llmPrompt =
            typeof scriptMeta?.llm?.prompt === 'string'
              ? scriptMeta.llm.prompt.trim()
              : '';
          if (llmPrompt) {
            const scriptContext = formatScriptContext({
              name: slash.name,
              output,
            });
            const response = await runAgentForChat(chatId, llmPrompt, {
              topicId,
              scriptContext,
            });
            await captureMemoryEvent({
              threadKey: memoryThreadKey,
              chatId,
              topicId,
              agentId: effectiveAgentId,
              role: 'assistant',
              kind: 'text',
              text: extractMemoryText(response),
            });
            stopTyping();
            await replyWithResponse(ctx, response);
            return;
          }
          lastScriptOutputs.set(topicKey, { name: slash.name, output });
          await captureMemoryEvent({
            threadKey: memoryThreadKey,
            chatId,
            topicId,
            agentId: effectiveAgentId,
            role: 'assistant',
            kind: 'text',
            text: extractMemoryText(output),
          });
          stopTyping();
          await replyWithResponse(ctx, output);
        } catch (err) {
          console.error(err);
          stopTyping();
          await replyWithError(ctx, `Error running /${slash.name}.`, err);
        }
      });
      return;
    }

    enqueue(topicKey, async () => {
      const stopTyping = startTyping(ctx);
      const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
      const memoryThreadKey = buildMemoryThreadKey(
        chatId,
        topicId,
        effectiveAgentId
      );
      try {
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'text',
          text,
        });
        const scriptContext = consumeScriptContext(topicKey);
        const response = await runAgentForChat(chatId, text, {
          topicId,
          scriptContext,
        });
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'assistant',
          kind: 'text',
          text: extractMemoryText(response),
        });
        stopTyping();
        await replyWithResponse(ctx, response);
      } catch (err) {
        console.error(err);
        stopTyping();
        await replyWithError(ctx, 'Error processing response.', err);
      }
    });
  });
}

module.exports = {
  registerTextHandler,
};

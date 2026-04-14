function registerTextHandler(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext,
    createReplyProgressReporter,
    enqueue,
    extractMemoryText,
    formatScriptContext,
    getTopicId,
    getReplyContext,
    lastScriptOutputs,
    parseSlashCommand,
    replyWithError,
    replyWithResponse,
    resolveEffectiveAgentId,
    runAgentForChat,
    runScriptCommand,
    scriptManager,
    steerActiveRun,
    startTyping,
  } = options;

  bot.on('text', async (ctx) => {
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
          'resume',
          'send_to_codex',
          'status',
          'stop',
          'memory',
          'reset',
          'cron',
          'later',
          'help',
          'document_scripts',
        ].includes(normalized)
      ) {
        return;
      }
      enqueue(topicKey, async () => {
        const stopTyping = startTyping(ctx);
        const progressReporter =
          typeof createReplyProgressReporter === 'function'
            ? createReplyProgressReporter(ctx)
            : null;
        let uiClosed = false;
        const finishUi = async () => {
          if (uiClosed) return;
          uiClosed = true;
          stopTyping();
          await progressReporter?.finish();
        };
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
            let responseSent = false;
            const response = await runAgentForChat(chatId, llmPrompt, {
              topicId,
              scriptContext,
              onProgressUpdate: async (lines) => {
                if (!progressReporter) return;
                await progressReporter.update(lines);
              },
              onFinalResponse: async (partialResponse) => {
                if (responseSent) return;
                responseSent = true;
                await replyWithResponse(ctx, partialResponse);
                await finishUi();
              },
              onSettled: async () => {
                await finishUi();
              },
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
            if (!responseSent) {
              await replyWithResponse(ctx, response);
              await finishUi();
            }
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
          await replyWithResponse(ctx, output);
          await finishUi();
        } catch (err) {
          if (err?.code === 'ERR_RUN_INTERRUPTED') {
            await finishUi();
            return;
          }
          console.error(err);
          await replyWithError(ctx, `Error running /${slash.name}.`, err);
          await finishUi();
        } finally {
          await finishUi();
        }
      });
      return;
    }

    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const replyContext = getReplyContext?.({
      agentId: effectiveAgentId,
      chatId,
      message: ctx.message,
      topicId,
    }) || null;
    const contextKey = replyContext?.contextKey;
    if (
      effectiveAgentId === 'codex-app'
      && typeof steerActiveRun === 'function'
    ) {
      try {
        const result = await steerActiveRun(
          chatId,
          topicId,
          text,
          effectiveAgentId,
          contextKey
        );
        if (result?.status === 'steered' || result?.status === 'queued') {
          const memoryThreadKey = buildMemoryThreadKey(
            chatId,
            topicId,
            effectiveAgentId,
            contextKey
          );
          await captureMemoryEvent({
            threadKey: memoryThreadKey,
            chatId,
            topicId,
            agentId: effectiveAgentId,
            role: 'user',
            kind: 'text',
            text,
          });

          const confirmation =
            result.status === 'queued'
              ? 'I will add that as soon as the active run finishes starting.'
              : 'Added to the active run.';
          await ctx.reply(confirmation);
          return;
        }
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'Error processing response.', err);
        return;
      }
    }

    enqueue(topicKey, async () => {
      const stopTyping = startTyping(ctx);
      const progressReporter =
        typeof createReplyProgressReporter === 'function'
          ? createReplyProgressReporter(ctx)
          : null;
      let uiClosed = false;
      const finishUi = async () => {
        if (uiClosed) return;
        uiClosed = true;
        stopTyping();
        await progressReporter?.finish();
      };
      const memoryThreadKey = buildMemoryThreadKey(
        chatId,
        topicId,
        effectiveAgentId,
        contextKey
      );
      try {
        let responseSent = false;
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
          contextKey,
          topicId,
          scriptContext,
          onProgressUpdate: async (lines) => {
            if (!progressReporter) return;
            await progressReporter.update(lines);
          },
          onFinalResponse: async (partialResponse) => {
            if (responseSent) return;
            responseSent = true;
            await replyWithResponse(ctx, partialResponse);
            await finishUi();
          },
          onSettled: async () => {
            await finishUi();
          },
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
        if (!responseSent) {
          await replyWithResponse(ctx, response);
          await finishUi();
        }
      } catch (err) {
        if (err?.code === 'ERR_RUN_INTERRUPTED') {
          await finishUi();
          return;
        }
        console.error(err);
        await replyWithError(ctx, 'Error processing response.', err);
        await finishUi();
      } finally {
        await finishUi();
      }
    });
  });
}

module.exports = {
  registerTextHandler,
};

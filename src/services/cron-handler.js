const { buildTelegramThreadExtra } = require('./telegram-topics');

function createCronHandler(options) {
  const {
    bot,
    buildTopicKey,
    buildMemoryThreadKey,
    captureMemoryEvent,
    enqueue,
    extractMemoryText,
    resolveEffectiveAgentId,
    runAgentForChat,
    sendResponseToChat,
  } = options;

  return async function handleCronTrigger(chatId, prompt, triggerOptions = {}) {
    const {
      jobId,
      agent,
      topicId,
      notifyFailure = true,
      attempt = 1,
      maxAttempts = 1,
      triggerReason = 'scheduled',
      scheduledAt,
    } = triggerOptions;
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId, agent);
    const memoryThreadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);
    const topicKey = buildTopicKey
      ? buildTopicKey(chatId, topicId)
      : `${String(chatId)}:${topicId ?? 'root'}`;

    const execute = async () => {
      console.info(
        `Cron job ${jobId} executing for chat ${chatId} topic=${
          topicId || 'none'
        }${agent ? ` (agent: ${agent})` : ''} reason=${triggerReason} attempt=${attempt}/${maxAttempts}${scheduledAt ? ` scheduledAt=${scheduledAt}` : ''}`
      );
      try {
        let responseSent = false;
        const silentTokens = ['HEARTBEAT_OK', 'CURATION_EMPTY'];
        const actionExtra = buildTelegramThreadExtra({ topicId, forceTopic: true });
        await bot.telegram.sendChatAction(chatId, 'typing', actionExtra);
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'cron',
          text: String(prompt || ''),
        });
        const response = await runAgentForChat(chatId, prompt, {
          agentId: agent,
          topicId,
          onFinalResponse: async (partialResponse) => {
            const matchedToken = silentTokens.find((t) =>
              String(partialResponse || '').includes(t)
            );
            if (matchedToken || responseSent) return;
            responseSent = true;
            await sendResponseToChat(chatId, partialResponse, {
              topicId,
              agentId: effectiveAgentId,
            });
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
        const matchedToken = silentTokens.find((t) => response.includes(t));
        if (matchedToken) {
          console.info(`Cron job ${jobId}: ${matchedToken} (silent)`);
          return { ok: true, response, silent: true };
        }
        if (!responseSent) {
          await sendResponseToChat(chatId, response, {
            topicId,
            agentId: effectiveAgentId,
          });
        }
        return { ok: true, response, silent: false };
      } catch (err) {
        console.error(`Cron job ${jobId} failed:`, err);
        if (notifyFailure) {
          try {
            const errExtra = buildTelegramThreadExtra({ topicId, forceTopic: true });
            await bot.telegram.sendMessage(
              chatId,
              `Cron job "${jobId}" failed: ${err.message}`,
              errExtra
            );
          } catch {}
        }
        return { ok: false, error: err };
      }
    };

    if (enqueue) {
      return enqueue(topicKey, execute);
    }
    return execute();
  };
}

module.exports = {
  createCronHandler,
};

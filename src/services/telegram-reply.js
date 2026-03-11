const fs = require('fs/promises');

function createTelegramReplyService(options) {
  const {
    bot,
    chunkMarkdown,
    chunkText,
    createScheduledRun,
    documentDir,
    extractDocumentTokens,
    extractImageTokens,
    extractScheduleOnceTokens,
    formatError,
    imageDir,
    isPathInside,
    markdownToTelegramHtml,
    resolveEffectiveAgentId,
  } = options;

  async function replyWithError(ctx, label, err) {
    const detail = formatError(err);
    const text = `${label}\n${detail}`.trim();
    for (const chunk of chunkText(text, 3500)) {
      await ctx.reply(chunk);
    }
  }

  function startTyping(ctx) {
    const send = async () => {
      try {
        await ctx.sendChatAction('typing');
      } catch (err) {
        console.error('Typing error', err);
      }
    };
    send();
    const timer = setInterval(send, 4000);
    return () => clearInterval(timer);
  }

  function formatProgressText(lines) {
    const items = Array.isArray(lines)
      ? lines.map((line) => String(line || '').trim()).filter(Boolean)
      : [];
    if (items.length === 0) return '';
    const recent = items.slice(-4);
    return ['Pensando...', '', ...recent.map((line) => `• ${line}`)].join('\n');
  }

  function createProgressReporter(transport) {
    let progressMessageId = null;
    let lastText = '';
    let queue = Promise.resolve();

    async function flush(action) {
      queue = queue
        .catch(() => {})
        .then(action)
        .catch((err) => {
          console.warn('Failed to update progress message:', err);
        });
      return queue;
    }

    return {
      async update(lines) {
        const text = formatProgressText(lines);
        if (!text || text === lastText) return;

        await flush(async () => {
          if (!progressMessageId) {
            const message = await transport.send(text);
            progressMessageId = message?.message_id || null;
          } else {
            await transport.edit(progressMessageId, text);
          }
          lastText = text;
        });
      },
      async finish() {
        if (!progressMessageId) return;
        const messageId = progressMessageId;
        progressMessageId = null;
        lastText = '';
        await flush(async () => {
          await transport.remove(messageId);
        });
      },
    };
  }

  function createReplyProgressReporter(ctx) {
    const chatId = ctx?.chat?.id;
    const topicId = ctx?.message?.message_thread_id;
    const threadExtra = topicId ? { message_thread_id: topicId } : {};
    return createProgressReporter({
      send: async (text) => ctx.reply(text, threadExtra),
      edit: async (messageId, text) =>
        ctx.telegram.editMessageText(chatId, messageId, undefined, text, threadExtra),
      remove: async (messageId) => ctx.telegram.deleteMessage(chatId, messageId),
    });
  }

  function createChatProgressReporter(chatId, topicId) {
    const threadExtra = topicId ? { message_thread_id: topicId } : {};
    return createProgressReporter({
      send: async (text) => bot.telegram.sendMessage(chatId, text, threadExtra),
      edit: async (messageId, text) =>
        bot.telegram.editMessageText(chatId, messageId, undefined, text, threadExtra),
      remove: async (messageId) => bot.telegram.deleteMessage(chatId, messageId),
    });
  }

  function buildScheduleConfirmation(run) {
    return `Scheduled one-shot run for ${run.runAt} (id: ${run.id}).`;
  }

  async function materializeScheduledRuns(response, defaults = {}) {
    const { cleanedText, schedules, errors } = extractScheduleOnceTokens(response || '');
    if (!createScheduledRun || schedules.length === 0) {
      return { cleanedText, confirmations: [], errors };
    }

    const confirmations = [];
    const failures = errors.slice();
    for (const schedule of schedules) {
      try {
        const run = await createScheduledRun({
          runAt: schedule.runAt || schedule.run_at,
          prompt: schedule.prompt,
          chatId: schedule.chatId ?? schedule.chat_id ?? defaults.chatId ?? null,
          topicId: schedule.topicId ?? schedule.topic_id ?? defaults.topicId ?? null,
          agent: schedule.agent || defaults.agentId || null,
          maxAttempts: schedule.maxAttempts ?? schedule.max_attempts,
          retryDelaySeconds:
            schedule.retryDelaySeconds ?? schedule.retry_delay_seconds,
          retryBackoffFactor:
            schedule.retryBackoffFactor ?? schedule.retry_backoff_factor,
          source: 'agent',
        });
        confirmations.push(buildScheduleConfirmation(run));
      } catch (err) {
        failures.push(`Failed to create scheduled run: ${err.message}`);
      }
    }

    return { cleanedText, confirmations, errors: failures };
  }

  async function replyWithResponse(ctx, response) {
    const { cleanedText: afterImages, imagePaths } = extractImageTokens(
      response || '',
      imageDir
    );
    const { cleanedText, documentPaths } = extractDocumentTokens(
      afterImages,
      documentDir
    );
    const topicId = ctx?.message?.message_thread_id;
    const chatId = ctx?.chat?.id;
    const agentId =
      typeof resolveEffectiveAgentId === 'function' && chatId
        ? resolveEffectiveAgentId(chatId, topicId)
        : null;
    const scheduleResult = await materializeScheduledRuns(cleanedText, {
      chatId,
      topicId,
      agentId,
    });
    const text = [
      scheduleResult.cleanedText.trim(),
      ...scheduleResult.confirmations,
      ...scheduleResult.errors,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (text) {
      for (const chunk of chunkMarkdown(text, 3000)) {
        const formatted = markdownToTelegramHtml(chunk) || chunk;
        await ctx.reply(formatted, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
    }
    const uniqueImages = Array.from(new Set(imagePaths));
    for (const imagePath of uniqueImages) {
      try {
        if (!isPathInside(imageDir, imagePath)) {
          console.warn('Skipping image outside IMAGE_DIR:', imagePath);
          continue;
        }
        await fs.access(imagePath);
        await ctx.replyWithPhoto({ source: imagePath });
      } catch (err) {
        console.warn('Failed to send image:', imagePath, err);
      }
    }
    const uniqueDocuments = Array.from(new Set(documentPaths));
    for (const documentPath of uniqueDocuments) {
      try {
        if (!isPathInside(documentDir, documentPath)) {
          console.warn('Skipping document outside DOCUMENT_DIR:', documentPath);
          continue;
        }
        await fs.access(documentPath);
        await ctx.replyWithDocument({ source: documentPath });
      } catch (err) {
        console.warn('Failed to send document:', documentPath, err);
      }
    }
    if (!text && uniqueImages.length === 0 && uniqueDocuments.length === 0) {
      await ctx.reply('(no response)');
    }
  }

  async function replyWithTranscript(ctx, transcript, replyToMessageId) {
    const header = 'Transcript:';
    const text = String(transcript || '').trim();
    const replyOptions = replyToMessageId
      ? { reply_to_message_id: replyToMessageId }
      : undefined;
    if (!text) {
      await ctx.reply(`${header}\n(vacía)`, replyOptions);
      return;
    }
    const maxChunkSize = Math.max(1, 3500 - header.length - 1);
    const chunks = chunkText(text, maxChunkSize);
    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = i === 0 ? `${header}\n` : '';
      await ctx.reply(`${prefix}${chunks[i]}`, replyOptions);
    }
  }

  async function sendResponseToChat(chatId, response, sendOptions = {}) {
    const { topicId, agentId } = sendOptions;
    const threadExtra = topicId ? { message_thread_id: topicId } : {};
    const { cleanedText: afterImages, imagePaths } = extractImageTokens(
      response || '',
      imageDir
    );
    const { cleanedText, documentPaths } = extractDocumentTokens(
      afterImages,
      documentDir
    );
    const scheduleResult = await materializeScheduledRuns(cleanedText, {
      chatId,
      topicId,
      agentId,
    });
    const text = [
      scheduleResult.cleanedText.trim(),
      ...scheduleResult.confirmations,
      ...scheduleResult.errors,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (text) {
      for (const chunk of chunkMarkdown(text, 3000)) {
        const formatted = markdownToTelegramHtml(chunk) || chunk;
        await bot.telegram.sendMessage(chatId, formatted, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        });
      }
    }
    const uniqueImages = Array.from(new Set(imagePaths));
    for (const imagePath of uniqueImages) {
      try {
        if (!isPathInside(imageDir, imagePath)) continue;
        await fs.access(imagePath);
        await bot.telegram.sendPhoto(chatId, { source: imagePath }, threadExtra);
      } catch (err) {
        console.warn('Failed to send image:', imagePath, err);
      }
    }
    const uniqueDocuments = Array.from(new Set(documentPaths));
    for (const documentPath of uniqueDocuments) {
      try {
        if (!isPathInside(documentDir, documentPath)) continue;
        await fs.access(documentPath);
        await bot.telegram.sendDocument(
          chatId,
          { source: documentPath },
          threadExtra
        );
      } catch (err) {
        console.warn('Failed to send document:', documentPath, err);
      }
    }
  }

  return {
    createChatProgressReporter,
    createReplyProgressReporter,
    replyWithError,
    replyWithResponse,
    replyWithTranscript,
    sendResponseToChat,
    startTyping,
  };
}

module.exports = {
  createTelegramReplyService,
};

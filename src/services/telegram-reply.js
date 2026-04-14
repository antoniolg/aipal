const fs = require('fs/promises');
const {
  buildTelegramThreadExtra,
  getTelegramMessageContext,
} = require('./telegram-topics');

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
    progressUpdateMinIntervalMs = 1000,
    resolveEffectiveAgentId,
  } = options;

  function escapeHtmlText(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderTelegramHtml(text) {
    const formatted = markdownToTelegramHtml(text);
    return formatted || escapeHtmlText(text);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRetryAfterMs(err) {
    const retryAfterSeconds = Number(err?.response?.parameters?.retry_after);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      return 0;
    }
    return retryAfterSeconds * 1000;
  }

  function getReplyThreadExtra(ctx) {
    return buildTelegramThreadExtra(getTelegramMessageContext(ctx?.message));
  }

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
    return ['Thinking...', '', ...recent.map((line) => `• ${line}`)].join('\n');
  }

  function formatProgressPayload(progress) {
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      if (progress.mode === 'raw') {
        return String(progress.text || '').trim();
      }
    }
    return formatProgressText(progress);
  }

  function truncateProgressText(text, maxLength = 3500) {
    const normalized = String(text || '').trim();
    if (!normalized || normalized.length <= maxLength) return normalized;
    const suffix = normalized.slice(-(maxLength - 5)).trimStart();
    return `...\n\n${suffix}`;
  }

  function createProgressReporter(transport) {
    let progressMessageId = null;
    let lastText = '';
    let closed = false;
    let queue = Promise.resolve();
    let lastSentAt = 0;
    let pending = null;
    let timer = null;

    async function flush(action) {
      queue = queue
        .catch(() => {})
        .then(action)
        .catch((err) => {
          console.warn('Failed to update progress message:', err);
        });
      return queue;
    }

    async function withRetry(action, options = {}) {
      const { allowWhenClosed = false } = options;
      try {
        return await action();
      } catch (err) {
        const retryAfterMs = getRetryAfterMs(err);
        if (!retryAfterMs || (closed && !allowWhenClosed)) {
          throw err;
        }
        await sleep(retryAfterMs);
        return action();
      }
    }

    async function applyProgress(payload) {
      if (!progressMessageId) {
        const message = await withRetry(() => transport.send(payload));
        progressMessageId = message?.message_id || null;
      } else {
        await withRetry(() => transport.edit(progressMessageId, payload));
      }
    }

    function scheduleFlush() {
      if (closed || !pending || timer) return queue;
      const minIntervalMs = Math.max(0, Number(transport.minIntervalMs) || 0);
      const elapsedMs = Date.now() - lastSentAt;
      const delayMs =
        lastSentAt > 0 ? Math.max(0, minIntervalMs - elapsedMs) : 0;
      if (delayMs === 0) {
        const payload = pending;
        pending = null;
        return flush(async () => {
          if (closed || !payload) return;
          await applyProgress(payload);
          lastSentAt = Date.now();
          if (pending) {
            scheduleFlush();
          }
        });
      }
      timer = setTimeout(() => {
        timer = null;
        const payload = pending;
        pending = null;
        void flush(async () => {
          if (closed || !payload) return;
          await applyProgress(payload);
          lastSentAt = Date.now();
          if (pending) {
            scheduleFlush();
          }
        });
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    return {
      async update(progress) {
        if (closed) return;
        const text = truncateProgressText(formatProgressPayload(progress));
        if (!text || text === lastText) return;
        const html = renderTelegramHtml(text);
        pending = { html, text };
        lastText = text;
        await scheduleFlush();
      },
      async finish() {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pending = null;
        if (!progressMessageId || typeof transport.remove !== 'function') {
          await queue.catch(() => {});
          return;
        }
        const messageId = progressMessageId;
        progressMessageId = null;
        lastText = '';
        await flush(async () => {
          await withRetry(() => transport.remove(messageId), {
            allowWhenClosed: true,
          });
        });
      },
    };
  }

  function createReplyProgressReporter(ctx) {
    const chatId = ctx?.chat?.id;
    const threadExtra = getReplyThreadExtra(ctx);
    return createProgressReporter({
      minIntervalMs: progressUpdateMinIntervalMs,
      send: async (payload) =>
        ctx.reply(payload.html, {
          disable_notification: true,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        }),
      edit: async (messageId, payload) =>
        ctx.telegram.editMessageText(chatId, messageId, undefined, payload.html, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        }),
      remove: async (messageId) => ctx.telegram.deleteMessage(chatId, messageId),
    });
  }

  function createChatProgressReporter(chatId, topicId) {
    const threadExtra = buildTelegramThreadExtra({ topicId, forceTopic: true });
    return createProgressReporter({
      minIntervalMs: progressUpdateMinIntervalMs,
      send: async (payload) =>
        bot.telegram.sendMessage(chatId, payload.html, {
          disable_notification: true,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        }),
      edit: async (messageId, payload) =>
        bot.telegram.editMessageText(chatId, messageId, undefined, payload.html, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        }),
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
    const { topicId } = getTelegramMessageContext(ctx?.message);
    const chatId = ctx?.chat?.id;
    const threadExtra = getReplyThreadExtra(ctx);
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
        const formatted = renderTelegramHtml(chunk);
        await ctx.reply(formatted, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
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
        await ctx.replyWithPhoto({ source: imagePath }, threadExtra);
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
        await ctx.replyWithDocument({ source: documentPath }, threadExtra);
      } catch (err) {
        console.warn('Failed to send document:', documentPath, err);
      }
    }
    if (!text && uniqueImages.length === 0 && uniqueDocuments.length === 0) {
      await ctx.reply('(no response)', threadExtra);
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
    const { topicId, agentId, onMessageSent } = sendOptions;
    const threadExtra = buildTelegramThreadExtra({ topicId, forceTopic: true });
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
        const formatted = renderTelegramHtml(chunk);
        const sentMessage = await bot.telegram.sendMessage(chatId, formatted, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...threadExtra,
        });
        await Promise.resolve(onMessageSent?.(sentMessage));
      }
    }
    const uniqueImages = Array.from(new Set(imagePaths));
    for (const imagePath of uniqueImages) {
      try {
        if (!isPathInside(imageDir, imagePath)) continue;
        await fs.access(imagePath);
        const sentMessage = await bot.telegram.sendPhoto(
          chatId,
          { source: imagePath },
          threadExtra
        );
        await Promise.resolve(onMessageSent?.(sentMessage));
      } catch (err) {
        console.warn('Failed to send image:', imagePath, err);
      }
    }
    const uniqueDocuments = Array.from(new Set(documentPaths));
    for (const documentPath of uniqueDocuments) {
      try {
        if (!isPathInside(documentDir, documentPath)) continue;
        await fs.access(documentPath);
        const sentMessage = await bot.telegram.sendDocument(
          chatId,
          { source: documentPath },
          threadExtra
        );
        await Promise.resolve(onMessageSent?.(sentMessage));
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

function registerMediaHandlers(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    createReplyProgressReporter,
    documentDir,
    downloadTelegramFile,
    extractMemoryText,
    getAudioPayload,
    getDocumentPayload,
    getImagePayload,
    getTopicId,
    imageDir,
    enqueue,
    replyWithError,
    replyWithResponse,
    replyWithTranscript,
    resolveEffectiveAgentId,
    runAgentForChat,
    safeUnlink,
    startTyping,
    transcribeAudio,
  } = options;

  bot.on(['voice', 'audio', 'document'], (ctx, next) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    const payload = getAudioPayload(ctx.message);
    if (!payload) return next();

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
      let audioPath;
      let transcriptPath;
      try {
        audioPath = await downloadTelegramFile(ctx, payload, {
          prefix: 'audio',
          errorLabel: 'audio',
        });
        const { text, outputPath } = await transcribeAudio(audioPath);
        transcriptPath = outputPath;
        await replyWithTranscript(ctx, text, ctx.message?.message_id);
        if (!text) {
          await ctx.reply("I couldn't transcribe the audio.");
          return;
        }
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'audio',
          text,
        });
        let responseSent = false;
        const response = await runAgentForChat(chatId, text, {
          topicId,
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
        if (err && err.code === 'ENOENT') {
          await replyWithError(
            ctx,
            "I can't find mlx_whisper. Install the mlx-whisper package and try again.",
            err
          );
        } else {
          await replyWithError(ctx, 'Error processing audio.', err);
        }
        await finishUi();
      } finally {
        await finishUi();
        await safeUnlink(audioPath);
        await safeUnlink(transcriptPath);
      }
    });
  });

  bot.on(['photo', 'document'], (ctx, next) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    const payload = getImagePayload(ctx.message);
    if (!payload) return next();

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
      let imagePath;
      try {
        imagePath = await downloadTelegramFile(ctx, payload, {
          dir: imageDir,
          prefix: 'image',
          errorLabel: 'image',
        });
        const caption = (ctx.message.caption || '').trim();
        const prompt = caption || 'User sent an image.';
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'image',
          text: prompt,
        });
        let responseSent = false;
        const response = await runAgentForChat(chatId, prompt, {
          topicId,
          imagePaths: [imagePath],
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
        await replyWithError(ctx, 'Error processing image.', err);
        await finishUi();
      } finally {
        await finishUi();
      }
    });
  });

  bot.on('document', (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    if (getAudioPayload(ctx.message) || getImagePayload(ctx.message)) return;
    const payload = getDocumentPayload(ctx.message);
    if (!payload) return;

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
      let documentPath;
      try {
        documentPath = await downloadTelegramFile(ctx, payload, {
          dir: documentDir,
          prefix: 'document',
          errorLabel: 'document',
        });
        const caption = (ctx.message.caption || '').trim();
        const prompt = caption || 'User sent a document.';
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'document',
          text: prompt,
        });
        let responseSent = false;
        const response = await runAgentForChat(chatId, prompt, {
          topicId,
          documentPaths: [documentPath],
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
        await replyWithError(ctx, 'Error processing document.', err);
        await finishUi();
      } finally {
        await finishUi();
      }
    });
  });
}

module.exports = {
  registerMediaHandlers,
};

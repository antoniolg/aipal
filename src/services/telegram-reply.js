const fs = require('fs/promises');

function createTelegramReplyService(options) {
  const {
    bot,
    chunkMarkdown,
    chunkText,
    documentDir,
    extractDocumentTokens,
    extractImageTokens,
    formatError,
    imageDir,
    isPathInside,
    markdownToTelegramHtml,
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

  async function replyWithResponse(ctx, response) {
    const { cleanedText: afterImages, imagePaths } = extractImageTokens(
      response || '',
      imageDir
    );
    const { cleanedText, documentPaths } = extractDocumentTokens(
      afterImages,
      documentDir
    );
    const text = cleanedText.trim();
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
    const { topicId } = sendOptions;
    const threadExtra = topicId ? { message_thread_id: topicId } : {};
    const { cleanedText: afterImages, imagePaths } = extractImageTokens(
      response || '',
      imageDir
    );
    const { cleanedText, documentPaths } = extractDocumentTokens(
      afterImages,
      documentDir
    );
    const text = cleanedText.trim();
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

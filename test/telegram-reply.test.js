const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTelegramReplyService } = require('../src/services/telegram-reply');

test('replyWithResponse sends formatted text chunk', async () => {
  const replies = [];
  const ctx = {
    reply: async (text, options) => {
      replies.push({ text, options });
    },
    replyWithPhoto: async () => {},
    replyWithDocument: async () => {},
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: () => ['Hello'],
    chunkText: () => [],
    createScheduledRun: async () => null,
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: 'Hello', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: 'Hello', imagePaths: [] }),
    extractScheduleOnceTokens: () => ({
      cleanedText: 'Hello',
      schedules: [],
      errors: [],
    }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: () => '<b>Hello</b>',
    resolveEffectiveAgentId: () => 'codex',
  });

  await service.replyWithResponse(ctx, 'ignored');

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, '<b>Hello</b>');
  assert.equal(replies[0].options.parse_mode, 'HTML');
});

test('replyWithResponse sends only in-scope attachments', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-reply-'));
  const imageDir = path.join(tmp, 'images');
  const documentDir = path.join(tmp, 'documents');
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(documentDir, { recursive: true });

  const insideImage = path.join(imageDir, 'in.png');
  const insideDoc = path.join(documentDir, 'in.pdf');
  const outsideImage = path.join(tmp, 'out.png');
  const outsideDoc = path.join(tmp, 'out.pdf');
  await fs.writeFile(insideImage, 'img');
  await fs.writeFile(insideDoc, 'doc');

  const sentPhotos = [];
  const sentDocs = [];
  const fallbackReplies = [];

  const ctx = {
    reply: async (text) => {
      fallbackReplies.push(text);
    },
    replyWithPhoto: async (payload) => {
      sentPhotos.push(payload.source);
    },
    replyWithDocument: async (payload) => {
      sentDocs.push(payload.source);
    },
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: () => [],
    chunkText: () => [],
    createScheduledRun: async () => null,
    documentDir,
    extractDocumentTokens: () => ({
      cleanedText: '',
      documentPaths: [insideDoc, outsideDoc],
    }),
    extractImageTokens: () => ({
      cleanedText: '',
      imagePaths: [insideImage, outsideImage],
    }),
    extractScheduleOnceTokens: () => ({
      cleanedText: '',
      schedules: [],
      errors: [],
    }),
    formatError: () => '',
    imageDir,
    isPathInside: (base, target) => target.startsWith(base + path.sep),
    markdownToTelegramHtml: () => '',
    resolveEffectiveAgentId: () => 'codex',
  });

  await service.replyWithResponse(ctx, 'ignored');

  assert.deepEqual(sentPhotos, [insideImage]);
  assert.deepEqual(sentDocs, [insideDoc]);
  assert.equal(fallbackReplies.length, 0);
});

test('sendResponseToChat preserves topicId in telegram sendMessage', async () => {
  const sentMessages = [];

  const service = createTelegramReplyService({
    bot: {
      telegram: {
        sendDocument: async () => {},
        sendMessage: async (chatId, text, options) => {
          sentMessages.push({ chatId, text, options });
        },
        sendPhoto: async () => {},
      },
    },
    chunkMarkdown: () => ['part-1', 'part-2'],
    chunkText: () => [],
    createScheduledRun: async () => null,
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: 'content', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: 'content', imagePaths: [] }),
    extractScheduleOnceTokens: () => ({
      cleanedText: 'content',
      schedules: [],
      errors: [],
    }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: (value) => value,
    resolveEffectiveAgentId: () => 'codex',
  });

  await service.sendResponseToChat(123, 'ignored', { topicId: 99 });

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].options.message_thread_id, 99);
  assert.equal(sentMessages[1].options.message_thread_id, 99);
});

test('replyWithResponse materializes schedule tokens and appends confirmation', async () => {
  const replies = [];
  const createdRuns = [];
  const ctx = {
    chat: { id: 123 },
    message: { message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
    replyWithPhoto: async () => {},
    replyWithDocument: async () => {},
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: (value) => [value],
    chunkText: () => [],
    createScheduledRun: async (payload) => {
      createdRuns.push(payload);
      return {
        id: 'once-1',
        runAt: '2026-03-20T08:30:00.000Z',
      };
    },
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: 'body', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: 'body', imagePaths: [] }),
    extractScheduleOnceTokens: () => ({
      cleanedText: '',
      schedules: [
        {
          runAt: '2026-03-20T09:30:00+01:00',
          prompt: 'Ping later',
        },
      ],
      errors: [],
    }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: (value) => value,
    resolveEffectiveAgentId: () => 'codex',
  });

  await service.replyWithResponse(ctx, 'ignored');

  assert.equal(createdRuns.length, 1);
  assert.equal(createdRuns[0].chatId, 123);
  assert.equal(createdRuns[0].topicId, 77);
  assert.equal(createdRuns[0].agent, 'codex');
  assert.match(replies[0], /Scheduled one-shot run/);
});

test('createReplyProgressReporter reuses a single Telegram message', async () => {
  const sent = [];
  const edited = [];
  const deleted = [];
  const ctx = {
    chat: { id: 123 },
    message: { message_thread_id: 77 },
    reply: async (text, options) => {
      sent.push({ text, options });
      return { message_id: 555 };
    },
    telegram: {
      editMessageText: async (chatId, messageId, _inline, text, options) => {
        edited.push({ chatId, messageId, text, options });
      },
      deleteMessage: async (chatId, messageId) => {
        deleted.push({ chatId, messageId });
      },
    },
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: () => [],
    chunkText: () => [],
    createScheduledRun: async () => null,
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: '', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: '', imagePaths: [] }),
    extractScheduleOnceTokens: () => ({
      cleanedText: '',
      schedules: [],
      errors: [],
    }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: () => '',
    resolveEffectiveAgentId: () => 'codex',
  });

  const reporter = service.createReplyProgressReporter(ctx);
  await reporter.update(['mirando el repo']);
  await reporter.update(['mirando el repo', 'preparando el cambio']);
  await reporter.finish();

  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].messageId, 555);
  assert.equal(edited[0].options.message_thread_id, 77);
  assert.deepEqual(deleted, [{ chatId: 123, messageId: 555 }]);
});

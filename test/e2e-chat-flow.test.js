const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerTextHandler } = require('../src/handlers/text');
const {
  buildPrompt,
  chunkMarkdown,
  chunkText,
  formatError,
  markdownToTelegramHtml,
  parseSlashCommand,
} = require('../src/message-utils');
const { createEnqueue } = require('../src/services/queue');
const { createAgentRunner } = require('../src/services/agent-runner');
const { createTelegramReplyService } = require('../src/services/telegram-reply');
const { buildThreadKey, buildTopicKey, resolveThreadId } = require('../src/thread-store');

function decodePromptFromCommand(command) {
  const match = command.match(/PROMPT_B64='([^']+)'/);
  if (!match) return '';
  return Buffer.from(match[1], 'base64').toString('utf8');
}

test('e2e: text handler runs bootstrap + agent + telegram reply with thread continuity', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-e2e-'));
  const imageDir = path.join(tmp, 'images');
  const documentDir = path.join(tmp, 'documents');
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(documentDir, { recursive: true });

  const bot = {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    },
  };

  const queues = new Map();
  const enqueue = createEnqueue(queues);
  const threadTurns = new Map();
  const threads = new Map();
  const capturedEvents = [];
  const commandHistory = [];
  const buildCalls = [];
  const replies = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      buildCalls.push(options);
      const thread = options.threadId || 'new';
      return `fake-agent --thread ${thread} --prompt ${options.promptExpression}`;
    },
    parseOutput(output) {
      let threadId;
      let text = '';
      let sawJson = false;
      for (const line of String(output || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          sawJson = true;
          if (data.type === 'thread.started') {
            threadId = data.thread_id;
          }
          if (data.type === 'item.completed' && data.item?.type === 'message') {
            text = data.item.text || text;
          }
        } catch {
          // Ignore non-json lines.
        }
      }
      return { threadId, text, sawJson };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async ({ threadKey }) => `BOOTSTRAP(${threadKey})`,
    buildMemoryRetrievalContext: async () => 'MEMORY_CONTEXT',
    buildPrompt,
    documentDir,
    execLocal: async (_cmd, args) => {
      const command = args[1];
      commandHistory.push(command);
      if (command.includes('--thread new')) {
        return [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'message', text: 'Primera respuesta' },
          }),
        ].join('\n');
      }

      return JSON.stringify({
        type: 'item.completed',
        item: { type: 'message', text: 'Segunda respuesta' },
      });
    },
    fileInstructionsEvery: 3,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake Agent',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir,
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (value) => value,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    shellQuote: (value) => `'${String(value).replace(/'/g, String.raw`'\\''`)}'`,
    threadTurns,
    wrapCommandWithPty: (value) => value,
    defaultTimeZone: 'UTC',
  });

  const replyService = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown,
    chunkText,
    documentDir,
    extractDocumentTokens: (value) => ({ cleanedText: String(value || ''), documentPaths: [] }),
    extractImageTokens: (value) => ({ cleanedText: String(value || ''), imagePaths: [] }),
    formatError,
    imageDir,
    isPathInside: () => true,
    markdownToTelegramHtml,
  });

  registerTextHandler({
    bot,
    buildMemoryThreadKey: buildThreadKey,
    buildTopicKey,
    captureMemoryEvent: async (event) => {
      capturedEvents.push(event);
    },
    consumeScriptContext: () => '',
    enqueue,
    extractMemoryText: (value) => String(value || ''),
    formatScriptContext: () => '',
    getTopicId: () => undefined,
    lastScriptOutputs: new Map(),
    parseSlashCommand,
    replyWithError: async (ctx, message) => {
      await ctx.reply(message);
    },
    replyWithResponse: replyService.replyWithResponse,
    resolveEffectiveAgentId: () => 'fake',
    runAgentForChat: agentRunner.runAgentForChat,
    runScriptCommand: async () => '',
    scriptManager: { getScriptMetadata: async () => ({}) },
    startTyping: () => () => {},
  });

  const textHandler = bot.handlers.get('text');
  assert.ok(textHandler);

  async function sendText(text) {
    const ctx = {
      chat: { id: 12345 },
      message: { text },
      reply: async (value, options) => {
        replies.push({ value, options });
      },
      sendChatAction: async () => {},
    };

    textHandler(ctx);
    const queueKey = buildTopicKey(ctx.chat.id, undefined);
    const queued = queues.get(queueKey);
    assert.ok(queued);
    await queued;
  }

  await sendText('Hola equipo');
  await sendText('¿Seguimos por el mismo hilo?');

  assert.equal(replies.length, 2);
  assert.equal(replies[0].value, 'Primera respuesta');
  assert.equal(replies[1].value, 'Segunda respuesta');

  assert.equal(buildCalls.length, 2);
  assert.equal(buildCalls[0].threadId, undefined);
  assert.equal(buildCalls[1].threadId, 'thread-1');

  const firstPrompt = decodePromptFromCommand(commandHistory[0]);
  const secondPrompt = decodePromptFromCommand(commandHistory[1]);
  assert.match(firstPrompt, /BOOTSTRAP\(12345:root:fake\)/);
  assert.match(firstPrompt, /MEMORY_CONTEXT/);
  assert.match(firstPrompt, /Hola equipo/);
  assert.match(secondPrompt, /\u00bfSeguimos por el mismo hilo\?/);
  assert.doesNotMatch(secondPrompt, /BOOTSTRAP\(/);

  assert.equal(capturedEvents.length, 4);
  assert.deepEqual(
    capturedEvents.map((event) => `${event.role}:${event.kind}`),
    ['user:text', 'assistant:text', 'user:text', 'assistant:text']
  );

  const persistedThreadId = threads.get(buildThreadKey(12345, undefined, 'fake'));
  assert.equal(persistedThreadId, 'thread-1');
});

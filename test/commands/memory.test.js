const assert = require('node:assert/strict');
const test = require('node:test');

const { registerMemoryCommand } = require('../../src/commands/memory');

function buildHarness(overrides = {}) {
  let handler;
  const replies = [];
  const searchCalls = [];
  const bot = {
    command(name, callback) {
      if (name === 'memory') handler = callback;
    },
  };
  registerMemoryCommand({
    bot,
    buildMemoryThreadKey: () => 'thread-key',
    buildTopicKey: () => 'topic-key',
    curateMemory: async () => ({}),
    enqueue: (_key, fn) => fn(),
    extractCommandValue: (text) => String(text || '').replace(/^\/memory(?:@\w+)?\s*/i, '').trim(),
    getMemoryStatus: async () => ({}),
    getThreadTail: async () => [
      { role: 'user', text: '¿Qué dijimos de PostFlow y calendarios?', createdAt: '2026-04-07T10:00:00.000Z' },
      { role: 'assistant', text: 'Lo vimos ayer.', createdAt: '2026-04-07T10:01:00.000Z' },
    ],
    memoryRetrievalLimit: 5,
    persistMemory: async (fn) => fn(),
    replyWithError: async (ctx, message) => ctx.reply(message),
    resolveEffectiveAgentId: () => 'codex-app',
    searchMemory: async (params) => {
      searchCalls.push(params);
      return [
        {
          createdAt: '2026-04-06T10:00:00.000Z',
          role: 'assistant',
          scope: 'global',
          text: 'PostFlow usa grid bounds para el calendario.',
        },
      ];
    },
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    getTopicId: () => undefined,
    ...overrides,
  });
  assert.ok(handler);
  const ctx = (text) => ({
    chat: { id: 123 },
    message: { text },
    reply: async (value) => replies.push(value),
  });
  return { ctx, handler, replies, searchCalls };
}

test('/memory without args searches from recent conversation context', async () => {
  const { ctx, handler, replies, searchCalls } = buildHarness();

  await handler(ctx('/memory'));

  assert.equal(searchCalls.length, 1);
  assert.match(searchCalls[0].query, /PostFlow y calendarios/);
  assert.equal(searchCalls[0].agentId, 'codex-app');
  assert.equal(searchCalls[0].limit, 5);
  assert.match(replies[0], /Memoria relevante/);
  assert.match(replies[0], /grid bounds/);
});

test('/memory with args searches the explicit query', async () => {
  const { ctx, handler, searchCalls } = buildHarness();

  await handler(ctx('/memory postflow calendario 3'));

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].query, 'postflow calendario');
  assert.equal(searchCalls[0].limit, 3);
});

test('/memory truncates long hits before replying', async () => {
  const { ctx, handler, replies } = buildHarness({
    searchMemory: async () => [
      {
        createdAt: '2026-04-06T10:00:00.000Z',
        role: 'assistant',
        scope: 'global',
        text: 'x'.repeat(5000),
      },
    ],
  });

  await handler(ctx('/memory algo largo'));

  assert.equal(replies.length, 1);
  assert.ok(replies[0].length < 1000);
  assert.match(replies[0], /x…/);
});

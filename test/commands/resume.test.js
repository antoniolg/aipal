const assert = require('node:assert/strict');
const test = require('node:test');

const { getAgent } = require('../../src/agents');
const { registerResumeCommand } = require('../../src/commands/resume');

function buildOptions(overrides = {}) {
  return {
    bot: {
      command(name, handler) {
        overrides.handlers.set(name, handler);
      },
    },
    getCodexAppThreadId: () => undefined,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    listResumeThreads: async () => [],
    readResumeThreadState: async () => 'status',
    replyWithError: async () => {},
    resolveEffectiveAgentId: () => 'codex-app',
    sendResumeThreadPicker: async () => {},
    ...overrides,
  };
}

test('/resume lists codex-app threads with picker buttons', async () => {
  const handlers = new Map();
  const pickerCalls = [];

  registerResumeCommand(buildOptions({
    handlers,
    listResumeThreads: async ({ agentId, query }) => {
      assert.equal(agentId, 'codex-app');
      assert.equal(query, 'demo');
      return [{ threadId: 'thread-1', title: 'Sesion demo', cwd: '/tmp/demo' }];
    },
    sendResumeThreadPicker: async (_ctx, payload) => {
      pickerCalls.push(payload);
    },
    getCodexAppThreadId: () => 'thread-old',
  }));

  const handler = handlers.get('resume');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/resume demo', message_thread_id: 77 },
  });

  assert.equal(pickerCalls.length, 1);
  assert.equal(pickerCalls[0].currentBinding, 'thread-old');
  assert.equal(pickerCalls[0].effectiveAgentLabel, 'codex-app');
  assert.equal(pickerCalls[0].query, 'demo');
});

test('/resume explains when there are no threads', async () => {
  const handlers = new Map();
  const replies = [];

  registerResumeCommand(buildOptions({ handlers }));
  const handler = handlers.get('resume');

  await handler({
    chat: { id: 1 },
    message: { text: '/resume nada', message_thread_id: 55 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.match(replies[0], /No se encontraron sesiones/);
});

test('/status reports effective agent and codex-app binding details', async () => {
  const handlers = new Map();
  const replies = [];

  registerResumeCommand(buildOptions({
    handlers,
    readResumeThreadState: async ({ chatId, effectiveAgentId, topicId }) => {
      assert.equal(chatId, 9);
      assert.equal(topicId, 333);
      assert.equal(effectiveAgentId, 'claude');
      return '<b>Agente activo:</b> claude';
    },
    resolveEffectiveAgentId: () => 'claude',
  }));

  const handler = handlers.get('status');
  await handler({
    chat: { id: 9 },
    message: { text: '/status', message_thread_id: 333 },
    reply: async (text, options) => {
      replies.push({ options, text });
    },
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /claude/);
  assert.equal(replies[0].options.parse_mode, 'HTML');
});

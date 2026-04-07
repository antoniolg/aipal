const assert = require('node:assert/strict');
const test = require('node:test');

const { createCronHandler } = require('../../src/services/cron-handler');

test('handleCronTrigger isolates cron context and mirrors prompt plus final output to shared memory', async () => {
  const events = [];
  const sentResponses = [];
  const runCalls = [];
  const typingCalls = [];

  const handleCronTrigger = createCronHandler({
    bot: {
      telegram: {
        sendChatAction: async (...args) => {
          typingCalls.push(args);
        },
      },
    },
    buildMemoryThreadKey: (chatId, topicId, agentId, contextKey) =>
      `${chatId}:${contextKey || topicId || 'root'}:${agentId}`,
    buildTopicKey: (chatId, topicId) => `${chatId}:${topicId || 'root'}`,
    captureMemoryEvent: async (event) => {
      events.push(event);
    },
    extractMemoryText: (value) => String(value || '').trim(),
    resolveEffectiveAgentId: (_chatId, _topicId, agent) => agent || 'codex',
    runAgentForChat: async (_chatId, prompt, options) => {
      runCalls.push({ prompt, options });
      await options.onFinalResponse('Resumen semanal');
      return 'Resumen semanal';
    },
    sendResponseToChat: async (chatId, response, options) => {
      sentResponses.push({ chatId, response, options });
    },
  });

  const result = await handleCronTrigger(123, 'haz el analisis', {
    jobId: 'weekly-social-strategy',
    topicId: 1575,
  });

  assert.equal(result.ok, true);
  assert.equal(typingCalls.length, 1);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].options.contextKey, 'cron:weekly-social-strategy');
  assert.equal(runCalls[0].options.restrictMemoryToThread, true);
  assert.equal(sentResponses.length, 1);
  assert.deepEqual(
    events.map((event) => ({
      threadKey: event.threadKey,
      role: event.role,
      kind: event.kind,
      text: event.text,
    })),
    [
      {
        threadKey: '123:cron:weekly-social-strategy:codex',
        role: 'user',
        kind: 'cron',
        text: 'haz el analisis',
      },
      {
        threadKey: '123:cron:weekly-social-strategy:codex',
        role: 'assistant',
        kind: 'text',
        text: 'Resumen semanal',
      },
      {
        threadKey: '123:1575:codex',
        role: 'user',
        kind: 'cron',
        text: 'haz el analisis',
      },
      {
        threadKey: '123:1575:codex',
        role: 'assistant',
        kind: 'text',
        text: 'Resumen semanal',
      },
    ]
  );
});

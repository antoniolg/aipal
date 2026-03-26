const assert = require('node:assert/strict');
const test = require('node:test');

const { getAgent } = require('../../src/agents');
const { registerStopCommand } = require('../../src/commands/stop');

test('/stop interrupts the active run for the effective topic agent', async () => {
  const handlers = new Map();
  const replies = [];
  const stopCalls = [];

  registerStopCommand({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    replyWithError: async () => {},
    resolveEffectiveAgentId: () => 'codex-app',
    stopActiveRun: async (chatId, topicId, agentId) => {
      stopCalls.push({ chatId, topicId, agentId });
      return { status: 'stopping', agentId };
    },
  });

  const handler = handlers.get('stop');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/stop', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.deepEqual(stopCalls, [{ chatId: 1, topicId: 77, agentId: 'codex-app' }]);
  assert.deepEqual(replies, ['Stopping codex-app...']);
});

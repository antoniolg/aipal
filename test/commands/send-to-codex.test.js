const assert = require('node:assert/strict');
const test = require('node:test');

const { registerSendToCodexCommand } = require('../../src/commands/send-to-codex');

test('/send_to_codex uses the current topic codex-app thread and opens the project picker', async () => {
  const handlers = new Map();
  const pickerCalls = [];

  registerSendToCodexCommand({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    getSendToCodexSourceThread: async ({ agentId, chatId, topicId }) => {
      assert.equal(agentId, 'codex-app');
      assert.equal(chatId, 1);
      assert.equal(topicId, 55);
      return { threadId: 'thread-aipal-1', title: 'Session', cwd: '/tmp/aipal' };
    },
    getTopicId: (ctx) => ctx.message.message_thread_id,
    replyWithError: async () => {},
    sendToCodexPicker: async (_ctx, sourceThread) => {
      pickerCalls.push(sourceThread);
    },
  });

  const handler = handlers.get('send_to_codex');
  await handler({
    chat: { id: 1 },
    message: { text: '/send_to_codex', message_thread_id: 55 },
  });

  assert.equal(pickerCalls.length, 1);
  assert.equal(pickerCalls[0].threadId, 'thread-aipal-1');
});

test('/send_to_codex explains when the current topic has no aipal codex-app thread', async () => {
  const handlers = new Map();
  const replies = [];

  registerSendToCodexCommand({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    getSendToCodexSourceThread: async () => null,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    replyWithError: async () => {},
    sendToCodexPicker: async () => {},
  });

  const handler = handlers.get('send_to_codex');
  await handler({
    chat: { id: 1 },
    message: { text: '/send_to_codex', message_thread_id: 55 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.match(replies[0], /does not currently have an aipal codex-app session/i);
});

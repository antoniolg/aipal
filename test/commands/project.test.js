const assert = require('node:assert/strict');
const test = require('node:test');

const { registerProjectCommand } = require('../../src/commands/project');

test('/project opens picker with current topic project', async () => {
  const handlers = new Map();
  const pickerCalls = [];

  registerProjectCommand({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    clearCodexAppThreadForTopic: () => {},
    clearProjectOverride: () => {},
    getProjectOverride: (chatId, topicId) => {
      assert.equal(chatId, 1);
      assert.equal(topicId, 55);
      return '/Users/antonio/Projects/antoniolg/aipal';
    },
    getTopicId: (ctx) => ctx.message.message_thread_id,
    persistProjectOverrides: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    sendProjectPicker: async (_ctx, params) => {
      pickerCalls.push(params);
    },
  });

  await handlers.get('project')({
    chat: { id: 1 },
    message: { text: '/project', message_thread_id: 55 },
  });

  assert.deepEqual(pickerCalls, [
    { currentProjectPath: '/Users/antonio/Projects/antoniolg/aipal' },
  ]);
});

test('/project reset clears the topic project and codex-app thread', async () => {
  const handlers = new Map();
  const calls = [];
  const replies = [];

  registerProjectCommand({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    clearCodexAppThreadForTopic: (chatId, topicId) => {
      calls.push(['clearThread', chatId, topicId]);
    },
    clearProjectOverride: (chatId, topicId) => {
      calls.push(['clearProject', chatId, topicId]);
      return true;
    },
    getProjectOverride: () => undefined,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    persistProjectOverrides: async () => {
      calls.push(['persistProjects']);
    },
    persistThreads: async () => {
      calls.push(['persistThreads']);
    },
    replyWithError: async () => {},
    sendProjectPicker: async () => {
      throw new Error('should not open picker during reset');
    },
  });

  await handlers.get('project')({
    chat: { id: 1 },
    message: { text: '/project reset', message_thread_id: 55 },
    reply: async (text) => replies.push(text),
  });

  assert.deepEqual(calls.slice(0, 2), [
    ['clearProject', 1, 55],
    ['clearThread', 1, 55],
  ]);
  assert.ok(calls.some(([name]) => name === 'persistProjects'));
  assert.ok(calls.some(([name]) => name === 'persistThreads'));
  assert.match(replies[0], /Project cleared/);
});

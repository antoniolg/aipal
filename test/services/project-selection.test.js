const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProjectSelectionService,
} = require('../../src/services/project-selection');

function createBotRecorder() {
  const sentMessages = [];

  return {
    bot: {
      telegram: {
        sendMessage: async (chatId, text, options) => {
          sentMessages.push({ chatId, options, text });
          return { message_id: 1001 };
        },
      },
    },
    sentMessages,
  };
}

test('project selection service shows topic project picker and persists selection', async () => {
  const { bot, sentMessages } = createBotRecorder();
  const calls = [];
  const edits = [];
  const answers = [];
  const service = createProjectSelectionService({
    bot,
    listProjects: async () => [
      { active: true, label: 'Aipal', path: '/Users/antonio/Projects/antoniolg/aipal' },
      { active: false, label: 'PostFlow', path: '/Users/antonio/Projects/antoniolg/postflow' },
    ],
    onSelectProject: async (entry) => {
      calls.push(entry);
      return {
        projectLabel: entry.project.label,
        projectPath: entry.project.path,
      };
    },
  });

  await service.sendProjectPicker(
    {
      chat: { id: 123 },
      message: { message_thread_id: 77 },
    },
    { currentProjectPath: '/Users/antonio/Projects/antoniolg/aipal' }
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Current: <code>\/Users/);
  assert.match(
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].text,
    /^✓ Aipal$/
  );

  const projectCallback =
    sentMessages[0].options.reply_markup.inline_keyboard[1][0].callback_data;

  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text = '') => {
      answers.push(text);
    },
    callbackQuery: { data: projectCallback },
    editMessageText: async (text, options) => {
      edits.push({ options, text });
    },
  });

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, 123);
  assert.equal(calls[0].topicId, 77);
  assert.equal(calls[0].project.path, '/Users/antonio/Projects/antoniolg/postflow');
  assert.match(edits[0].text, /Project set for this topic/);
  assert.match(edits[0].text, /postflow/);
  assert.equal(answers.at(-1), 'Project set.');

  service.shutdown();
});

test('project selection service paginates project picker results', async () => {
  const { bot, sentMessages } = createBotRecorder();
  const edits = [];
  const answers = [];
  const service = createProjectSelectionService({
    bot,
    listProjects: async () =>
      Array.from({ length: 11 }, (_, index) => ({
        active: index === 0,
        label: `Proyecto ${index + 1}`,
        path: `/Users/antonio/Projects/demo-${index + 1}`,
      })),
    onSelectProject: async () => {
      throw new Error('should not select during pagination test');
    },
  });

  await service.sendProjectPicker({
    chat: { id: 123 },
    message: { message_thread_id: 77 },
  });

  assert.match(sentMessages[0].text, /Showing 1-10/);
  const nextCallback =
    sentMessages[0].options.reply_markup.inline_keyboard.at(-1)[0].callback_data;
  assert.match(nextCallback, /^project_page:/);

  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text = '') => {
      answers.push(text);
    },
    callbackQuery: { data: nextCallback },
    editMessageText: async (text, options) => {
      edits.push({ options, text });
    },
  });

  assert.equal(handled, true);
  assert.match(edits[0].text, /Showing 11-11/);
  assert.equal(edits[0].options.reply_markup.inline_keyboard.at(-1)[0].text, 'Previous');
  assert.equal(answers.at(-1), '');

  service.shutdown();
});

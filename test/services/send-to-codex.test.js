const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSendToCodexService,
} = require('../../src/services/send-to-codex');

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

test('send to codex service shows project picker for the current session and confirms export', async () => {
  const { bot, sentMessages } = createBotRecorder();
  const calls = [];
  const edits = [];
  const answers = [];
  const service = createSendToCodexService({
    bot,
    listProjects: async () => [
      { active: true, label: 'Aipal', path: '/Users/antonio/Projects/antoniolg/aipal' },
      { active: false, label: 'Publisher', path: '/Users/antonio/Projects/antoniolg/publisher' },
    ],
    onSendToCodex: async (entry) => {
      calls.push(entry);
      return {
        forkedThreadId: 'thread-forked',
        projectPath: entry.project.path,
        sourceThreadId: entry.sourceThread.threadId,
      };
    },
  });

  await service.sendProjectPicker(
    {
      chat: { id: 123 },
      message: { message_thread_id: 77 },
    },
    { threadId: 'thread-aipal-1', title: 'Sesion 1', cwd: '/tmp/aipal-1' }
  );

  assert.equal(sentMessages.length, 1);
  const projectCallback =
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data;

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
  assert.equal(calls[0].sourceThread.threadId, 'thread-aipal-1');
  assert.equal(calls[0].project.path, '/Users/antonio/Projects/antoniolg/aipal');
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Sesion enviada a Codex App/);
  assert.match(edits[0].text, /thread-forked/);
  assert.equal(answers.at(-1), 'Sesion enviada.');

  service.shutdown();
});

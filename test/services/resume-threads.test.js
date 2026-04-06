const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PAGE_CALLBACK_PREFIX,
  createResumeThreadsService,
  formatThreadButton,
} = require('../../src/services/resume-threads');

function createBotRecorder() {
  const sentMessages = [];

  return {
    bot: {
      telegram: {
        sendMessage: async (chatId, text, options) => {
          sentMessages.push({ chatId, options, text });
          return { message_id: 901 };
        },
      },
    },
    sentMessages,
  };
}

test('formatThreadButton renders source, title, cwd and short id', () => {
  const text = formatThreadButton({
    cwd: '/Users/antonio/Projects/antoniolg/aipal',
    sourceKind: 'cli',
    threadId: 'thread-1234567890abcdef',
    title: 'Good session',
  });

  assert.match(text, /\[CLI\]/);
  assert.match(text, /Good session/);
  assert.match(text, /aipal/);
  assert.match(text, /#567890abcdef/);
});

test('resume threads service sends picker and handles selections', async () => {
  const { bot, sentMessages } = createBotRecorder();
  const selections = [];
  const answers = [];
  const edits = [];
  const replies = [];
  const service = createResumeThreadsService({
    bot,
    onSelectThread: async (entry, ctx) => {
      selections.push(entry);
      await ctx.editMessageText('ok', { reply_markup: { inline_keyboard: [] } });
    },
  });

  await service.sendThreadPicker(
    {
      chat: { id: 123 },
      message: { message_thread_id: 77 },
    },
    {
      currentBinding: 'thread-old',
      effectiveAgentLabel: 'claude',
      query: 'demo',
      threads: [
        { cwd: '/tmp/demo', threadId: 'thread-1', title: 'Session 1' },
      ],
    }
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 123);
  assert.equal(sentMessages[0].options.message_thread_id, 77);
  assert.match(sentMessages[0].text, /codex-app/);
  assert.match(sentMessages[0].text, /claude/);

  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text) => {
      answers.push(text);
    },
    callbackQuery: { data: callbackData },
    editMessageText: async (text, options) => {
      edits.push({ options, text });
    },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.equal(handled, true);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].chatId, 123);
  assert.equal(selections[0].thread.threadId, 'thread-1');
  assert.equal(edits.length, 1);
  assert.match(answers[0], /Session resumed/);

  const staleHandled = await service.handleCallbackQuery({
    answerCbQuery: async (text) => {
      answers.push(text);
    },
    callbackQuery: { data: callbackData },
  });
  assert.equal(staleHandled, true);
  assert.equal(answers[1], 'This selection is no longer active.');

  service.shutdown();
});

test('resume threads service paginates long thread lists', async () => {
  const { bot, sentMessages } = createBotRecorder();
  const edits = [];
  const answers = [];
  const service = createResumeThreadsService({
    bot,
    onSelectThread: async () => {},
  });

  await service.sendThreadPicker(
    {
      chat: { id: 555 },
      message: { message_thread_id: 99 },
    },
    {
      currentBinding: 'thread-old',
      effectiveAgentLabel: 'codex-app',
      query: '',
      threads: Array.from({ length: 12 }, (_, index) => ({
        cwd: `/tmp/project-${index + 1}`,
        sourceKind: index === 0 ? 'cli' : undefined,
        threadId: `thread-${index + 1}`,
        title: `Session ${index + 1}`,
      })),
    }
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Showing 1-10/);
  assert.equal(sentMessages[0].options.reply_markup.inline_keyboard.length, 11);
  assert.equal(
    sentMessages[0].options.reply_markup.inline_keyboard.at(-1)[0].text,
    'Next'
  );

  const nextCallback =
    sentMessages[0].options.reply_markup.inline_keyboard.at(-1)[0].callback_data;
  assert.match(nextCallback, new RegExp(`^${PAGE_CALLBACK_PREFIX}:`));

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
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Showing 11-12/);
  assert.equal(edits[0].options.reply_markup.inline_keyboard.length, 3);
  assert.equal(
    edits[0].options.reply_markup.inline_keyboard.at(-1)[0].text,
    'Previous'
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0], '');

  service.shutdown();
});

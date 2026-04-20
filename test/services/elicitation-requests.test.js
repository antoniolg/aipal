const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createElicitationService,
} = require('../../src/services/elicitation-requests');

function createBotRecorder() {
  const sentMessages = [];
  const editedMessages = [];

  return {
    bot: {
      telegram: {
        editMessageText: async (chatId, messageId, inlineMessageId, text, options) => {
          editedMessages.push({ chatId, messageId, inlineMessageId, text, options });
        },
        sendMessage: async (chatId, text, options) => {
          sentMessages.push({ chatId, text, options });
          return { message_id: 778 };
        },
      },
    },
    editedMessages,
    sentMessages,
  };
}

test('elicitation service sends URL requests to Telegram and resolves accept callbacks', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createElicitationService({ bot, logger: { warn() {} } });
  const answers = [];

  const responsePromise = service.requestElicitation(
    {
      threadId: 'thread-1',
      requestId: 31,
      serverName: 'Notion',
      mode: 'url',
      message: 'Conecta tu cuenta',
      url: 'https://example.com/auth',
      elicitationId: 'eli-1',
    },
    {
      chatId: 123,
      topicId: 77,
    }
  );
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 123);
  assert.equal(sentMessages[0].options.message_thread_id, 77);
  assert.match(sentMessages[0].text, /Notion/);
  assert.match(sentMessages[0].text, /example\.com\/auth/);
  assert.equal(sentMessages[0].options.reply_markup.inline_keyboard[0][0].url, 'https://example.com/auth');

  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[1][0].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: callbackData },
  });

  assert.equal(handled, true);
  await Promise.resolve();
  assert.deepEqual(await responsePromise, { action: 'accept', content: null });
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> aceptada/);
  assert.equal(answers[0].text, 'Accion: aceptada');

  service.shutdown();
});

test('elicitation service exposes accept always when the request supports persistent approval', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createElicitationService({ bot, logger: { warn() {} } });
  const answers = [];

  const responsePromise = service.requestElicitation(
    {
      threadId: 'thread-1b',
      requestId: 33,
      serverName: 'Notion',
      mode: 'form',
      message: 'Aprueba este conector',
      requestedSchema: {
        type: 'object',
        properties: {},
      },
      _meta: {
        persist: ['always'],
      },
    },
    {
      chatId: 123,
      topicId: 77,
    }
  );
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
  const buttons = sentMessages[0].options.reply_markup.inline_keyboard[0];
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].text, 'Aceptar');
  assert.equal(buttons[1].text, 'Aceptar Siempre');
  assert.equal(buttons[2].text, 'Rechazar');

  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: buttons[1].callback_data },
  });

  assert.equal(handled, true);
  await Promise.resolve();
  assert.deepEqual(await responsePromise, {
    action: 'accept',
    content: null,
    _meta: { persist: 'always' },
  });
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> aceptada siempre/);
  assert.equal(answers[0].text, 'Accion: aceptada siempre');

  service.shutdown();
});

test('elicitation service limits unsupported forms to decline or cancel', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createElicitationService({ bot, logger: { warn() {} } });
  const answers = [];

  const responsePromise = service.requestElicitation(
    {
      threadId: 'thread-2',
      requestId: 32,
      serverName: 'Notion',
      mode: 'form',
      message: 'Rellena este formulario',
      requestedSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
        },
      },
    },
    {
      chatId: 456,
      topicId: 88,
    }
  );
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /todavia no soporta responder este formulario/);
  assert.equal(sentMessages[0].options.reply_markup.inline_keyboard[0].length, 2);
  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: callbackData },
  });

  assert.equal(handled, true);
  assert.equal(answers[0].text, 'Accion: rechazada');
  await Promise.resolve();
  assert.deepEqual(await responsePromise, { action: 'decline', content: null });
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> rechazada/);

  service.shutdown();
});

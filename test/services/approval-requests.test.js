const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createApprovalService,
} = require('../../src/services/approval-requests');

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
          return { message_id: 777 };
        },
      },
    },
    editedMessages,
    sentMessages,
  };
}

test('approval service sends command approvals to Telegram and resolves accept callbacks', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createApprovalService({ bot, logger: { warn() {} } });
  const answers = [];

  const decisionPromise = service.requestApproval(
    {
      command: 'npm test',
      cwd: '/tmp/demo',
      kind: 'command_execution',
      networkApprovalContext: { protocol: 'https', host: 'api.openai.com', port: 443 },
      reason: 'Necesita acceso a red',
      requestId: 55,
      threadId: 'thread-55',
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
  assert.match(sentMessages[0].text, /npm test/);
  assert.match(sentMessages[0].text, /api\.openai\.com/);

  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: callbackData },
  });

  assert.equal(handled, true);
  await Promise.resolve();
  assert.equal(await decisionPromise, 'accept');
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> aprobada/);
  assert.equal(answers[0].text, 'Decision: aprobada');

  service.shutdown();
});

test('approval service marks resolved approvals as stale and rejects later callbacks', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createApprovalService({ bot, logger: { warn() {} } });
  const answers = [];

  const decisionPromise = service.requestApproval(
    {
      grantRoot: '/tmp/demo',
      item: {
        changes: [
          { path: '/tmp/demo/a.js' },
          { path: '/tmp/demo/b.js' },
        ],
      },
      kind: 'file_change',
      reason: 'Aplicar cambios',
      requestId: 88,
      threadId: 'thread-88',
    },
    {
      chatId: 456,
      topicId: 1,
    }
  );
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].options.message_thread_id, undefined);
  assert.match(sentMessages[0].text, /cambios de archivos/);
  assert.match(sentMessages[0].text, /a\.js/);

  service.resolveServerRequest({ requestId: 88, threadId: 'thread-88' });

  await Promise.resolve();
  assert.equal(await decisionPromise, null);
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> resuelta/);

  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: callbackData },
  });

  assert.equal(handled, true);
  assert.equal(answers[0].text, 'Esta approval ya no esta activa.');

  service.shutdown();
});

test('approval service renders permission approvals with requested scopes', async () => {
  const { bot, editedMessages, sentMessages } = createBotRecorder();
  const service = createApprovalService({ bot, logger: { warn() {} } });
  const answers = [];

  const decisionPromise = service.requestApproval(
    {
      kind: 'permissions',
      permissions: {
        fileSystem: {
          read: ['/tmp/demo/input.md'],
          write: ['/tmp/demo/output'],
        },
        network: { enabled: true },
      },
      reason: 'Acceso temporal para completar la tarea',
      requestId: 99,
      threadId: 'thread-99',
    },
    {
      chatId: 222,
      topicId: 9,
    }
  );
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Tipo:<\/b> permisos/);
  assert.match(sentMessages[0].text, /input\.md/);
  assert.match(sentMessages[0].text, /output/);
  assert.match(sentMessages[0].text, /Red:<\/b> habilitada/);

  const callbackData =
    sentMessages[0].options.reply_markup.inline_keyboard[0][1].callback_data;
  const handled = await service.handleCallbackQuery({
    answerCbQuery: async (text, options) => {
      answers.push({ options, text });
    },
    callbackQuery: { data: callbackData },
  });

  assert.equal(handled, true);
  await Promise.resolve();
  assert.equal(await decisionPromise, 'acceptForSession');
  assert.equal(editedMessages.length, 1);
  assert.match(editedMessages[0].text, /Estado:<\/b> aprobada para la sesion/);
  assert.equal(answers[0].text, 'Decision: aprobada para la sesion');

  service.shutdown();
});

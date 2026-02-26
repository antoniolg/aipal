const assert = require('node:assert/strict');
const test = require('node:test');

const { registerSettingsCommands } = require('../src/commands/settings');

const FIXTURE_SESSIONS = [
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    timestamp: '2026-02-02T10:00:00Z',
    cwd: '/work/project-b',
    displayName: 'Proyecto B reciente',
  },
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    timestamp: '2026-02-01T10:00:00Z',
    cwd: '/work/project-a',
    displayName: 'Proyecto A reciente',
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    timestamp: '2026-01-01T10:00:00Z',
    cwd: '/work/project-a',
    displayName: 'Proyecto A histórico',
  },
];

function createBotMock() {
  return {
    commands: new Map(),
    hearsHandlers: [],
    actionHandlers: [],
    onHandlers: new Map(),
    command(name, handler) {
      this.commands.set(name, handler);
    },
    hears(trigger, handler) {
      this.hearsHandlers.push({ trigger, handler });
    },
    action(trigger, handler) {
      this.actionHandlers.push({ trigger, handler });
    },
    on(event, handler) {
      this.onHandlers.set(event, handler);
    },
  };
}

function findHearsHandler(bot, source) {
  return bot.hearsHandlers.find(
    ({ trigger }) => trigger instanceof RegExp && trigger.source === source
  )?.handler;
}

function findActionHandler(bot, source) {
  return bot.actionHandlers.find(
    ({ trigger }) => trigger instanceof RegExp && trigger.source === source
  )?.handler;
}

function createOptions({
  allowedUsers = new Set(['1']),
  replies,
  callbacks,
  setThreadCalls,
  clearThreadCalls,
  configUpdates,
} = {}) {
  const sessions = [...FIXTURE_SESSIONS];
  const isPathInside = (cwd, target) =>
    String(target || '').startsWith(String(cwd || ''));

  return {
    allowedUsers,
    bot: createBotMock(),
    buildTopicKey: (chatId, topicId) => `${chatId}:${topicId ?? 'root'}`,
    clearAgentOverride: () => {},
    clearModelOverride: () => ({ hadOverride: false, nextModels: {} }),
    clearThreadForAgent: (...args) => {
      clearThreadCalls.push(args);
    },
    curateMemory: async () => '',
    execLocal: async () => '',
    extractCommandValue: (text) => String(text || '').split(/\s+/).slice(1).join(' ').trim(),
    getAgent: () => ({ label: 'Codex' }),
    getAgentLabel: () => 'Codex',
    getAgentOverride: () => '',
    getGlobalAgent: () => 'codex',
    getGlobalAgentCwd: () => '',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => '',
    getThreads: () => new Map([['1:root:codex', FIXTURE_SESSIONS[0].id]]),
    getLocalCodexSessionLastMessage: async (id) => `preview:${id.slice(0, 8)}`,
    getTopicId: (ctx) => ctx?.message?.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    normalizeAgent: (value) => value,
    normalizeTopicId: (topicId) => (topicId == null ? 'root' : String(topicId)),
    resolveThreadId: (_threads, _chatId, _topicId, _agentId) => ({
      threadId: FIXTURE_SESSIONS[0].id,
    }),
    persistAgentOverrides: async () => {},
    persistMemory: async (task) => task(),
    persistThreads: async () => {},
    listLocalCodexSessions: async ({ limit = 10, cwd } = {}) => {
      const filtered = sessions.filter((session) => {
        if (!cwd) return true;
        const normalized = String(cwd).trim();
        return session.cwd === normalized || isPathInside(normalized, session.cwd);
      });
      return filtered.slice(0, limit);
    },
    replyWithError: async (_ctx, message) => {
      replies.push({ text: message, options: {} });
    },
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalAgentCwd: () => {},
    setGlobalModels: () => {},
    setGlobalThinking: () => {},
    setMemoryEventsSinceCurate: () => {},
    setThreadForAgent: (...args) => {
      setThreadCalls.push(args);
    },
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async (value) => {
      configUpdates.push(value);
    },
    wrapCommandWithPty: (value) => value,
    isValidSessionId: () => true,
  };
}

function createCtx(replies, callbacks, text = '', topicId, chatId = 1) {
  return {
    chat: { id: chatId },
    message: { text, message_thread_id: topicId },
    callbackQuery: { message: { chat: { id: chatId }, message_thread_id: topicId } },
    reply: async (value, options = {}) => {
      replies.push({ text: value, options });
    },
    answerCbQuery: async (value, options = {}) => {
      callbacks.push({ text: value, options });
    },
  };
}

test('/menu shows the main persistent keyboard', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const handler = bot.commands.get('menu');
  await handler(createCtx(replies, callbacks, '/menu'));

  const last = replies.at(-1);
  assert.equal(last.text, 'Menú principal:');
  assert.equal(last.options.reply_markup.keyboard[0][0].text, 'Projects');
  const allButtons = last.options.reply_markup.keyboard.flat().map((btn) => btn.text);
  assert.equal(allButtons.includes('Sesiones'), false);
});

test('/projects and keyboard Projects open the same projects keyboard flow', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects'));
  const fromCommand = replies.at(-1);

  const projectsHears = findHearsHandler(bot, '^projects?$');
  await projectsHears(createCtx(replies, callbacks, 'Projects'));
  const fromKeyboard = replies.at(-1);

  assert.match(fromCommand.text, /^Selecciona un proyecto/);
  assert.match(fromKeyboard.text, /^Selecciona un proyecto/);
  assert.equal(fromCommand.options.reply_markup.keyboard.at(-1)[0].text, 'Volver');
  assert.equal(fromKeyboard.options.reply_markup.keyboard.at(-1)[0].text, 'Volver');
});

test('project selection creates new session directly and returns main keyboard', async () => {
  const replies = [];
  const callbacks = [];
  const setThreadCalls = [];
  const clearThreadCalls = [];
  const configUpdates = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls,
    clearThreadCalls,
    configUpdates,
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects'));

  const projectLabel = replies.at(-1).options.reply_markup.keyboard[0][0].text;
  await catchAll(createCtx(replies, callbacks, projectLabel), async () => {});

  const confirm = replies.at(-1);
  assert.match(confirm.text, /Se creó una sesión nueva/);
  assert.equal(confirm.options.reply_markup.keyboard[0][0].text, 'Projects');
  assert.equal(setThreadCalls.length, 0);
  assert.equal(clearThreadCalls.length, 1);
  assert.equal(configUpdates.length > 0, true);
});

test('nueva sesión from /sessions clears current thread and returns main keyboard', async () => {
  const replies = [];
  const callbacks = [];
  const setThreadCalls = [];
  const clearThreadCalls = [];
  const configUpdates = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls,
    clearThreadCalls,
    configUpdates,
  });
  options.getGlobalAgentCwd = () => '/work/project-a';
  const bot = options.bot;
  registerSettingsCommands(options);

  const newSession = findHearsHandler(bot, '^nueva sesión$');
  await bot.commands.get('sessions')(createCtx(replies, callbacks, '/sessions'));

  await newSession(createCtx(replies, callbacks, 'Nueva sesión'));
  const confirm = replies.at(-1);
  assert.match(confirm.text, /Se creó una sesión nueva/);
  assert.equal(confirm.options.reply_markup.keyboard[0][0].text, 'Projects');
  assert.equal(clearThreadCalls.length, 1);
  assert.equal(setThreadCalls.length, 0);
  assert.equal(configUpdates.length > 0, true);
});

test('menu catch-all does not block normal text when no menu state exists', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    allowedUsers: new Set(),
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  let nextCalls = 0;
  await catchAll(createCtx(replies, callbacks, 'hola', undefined, 999), async () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(replies.length, 0);
});

test('legacy inline actions show replaced-menu message', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const action = findActionHandler(bot, '^project_open:([a-z0-9]+):([0-9]+)$');
  const ctx = createCtx(replies, callbacks, '');
  ctx.match = ['project_open:abc123:0', 'abc123', '0'];
  await action(ctx);

  assert.equal(callbacks.at(-1).text, 'Este menú expiró o fue reemplazado. Usa /menu.');
  assert.equal(replies.at(-1).text, 'Este menú expiró o fue reemplazado. Usa /menu.');
});

test('unknown text inside projects menu is consumed and does not go to next handler', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects'));

  let nextCalls = 0;
  await catchAll(createCtx(replies, callbacks, 'texto-inexistente'), async () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.match(replies.at(-1).text, /No reconocí ese proyecto/);
});

test('project selection still works when topic id changes between messages', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects', undefined, 777));
  const projectLabel = replies.at(-1).options.reply_markup.keyboard[0][0].text;

  await catchAll(createCtx(replies, callbacks, projectLabel, 123, 777), async () => {});

  assert.match(replies.at(-1).text, /Se creó una sesión nueva/);
  assert.equal(replies.at(-1).options.reply_markup.keyboard[0][0].text, 'Projects');
});

test('P#/S# selector without active menu is consumed and does not reach next handler', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  let nextCalls = 0;
  await catchAll(createCtx(replies, callbacks, 'P1 · demo-project', undefined, 555), async () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.match(replies.at(-1).text, /menú expiró o fue reemplazado/i);
});

test('/projects menu is available even when current agent is not codex', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  options.getGlobalAgent = () => 'claude';
  const bot = options.bot;
  registerSettingsCommands(options);

  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects'));
  assert.match(replies.at(-1).text, /^Selecciona un proyecto/);
});

test('expired menu selector with mismatched instance id is rejected', async () => {
  const replies = [];
  const callbacks = [];
  const options = createOptions({
    replies,
    callbacks,
    setThreadCalls: [],
    clearThreadCalls: [],
    configUpdates: [],
  });
  const bot = options.bot;
  registerSettingsCommands(options);

  const catchAll = findHearsHandler(bot, '^.+$');
  await bot.commands.get('projects')(createCtx(replies, callbacks, '/projects'));
  const projectLabel = replies.at(-1).options.reply_markup.keyboard[0][0].text;
  const staleLabel = projectLabel.replace(/^[A-Za-z0-9]{4,8}/, 'ZZZZ');

  await catchAll(createCtx(replies, callbacks, staleLabel), async () => {});
  assert.match(replies.at(-1).text, /menú expiró o fue reemplazado/i);
});

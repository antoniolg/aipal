const assert = require('node:assert/strict');
const test = require('node:test');

const { getAgent } = require('../../src/agents');
const { registerSettingsCommands } = require('../../src/commands/settings');

test('/model uses the effective topic agent when listing models', async () => {
  const handlers = new Map();
  const replies = [];
  const listedAgents = [];

  registerSettingsCommands({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    buildTopicKey: () => '1:77',
    clearAgentOverride: () => {},
    clearModelOverride: (models) => ({ hadOverride: false, nextModels: models }),
    clearThreadForAgent: () => {},
    curateMemory: async () => {},
    execLocal: async () => {
      throw new Error('execLocal should not be used when listAgentModels is provided');
    },
    extractCommandValue: () => '',
    getAgent,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getAgentOverride: () => 'codex-app',
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({}),
    getGlobalServiceTiers: () => ({}),
    getGlobalThinking: () => null,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    listAgentModels: async (agentId) => {
      listedAgents.push(agentId);
      return 'gpt-5.4-codex';
    },
    normalizeAgent: (value) => value,
    normalizeTopicId: (value) => value,
    persistAgentOverrides: async () => {},
    persistMemory: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalModels: () => {},
    setGlobalServiceTiers: () => {},
    setGlobalThinking: () => {},
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async () => {},
    wrapCommandWithPty: (value) => value,
  });

  const handler = handlers.get('model');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/model', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.deepEqual(listedAgents, ['codex-app']);
  assert.match(replies[0], /Current model for codex-app:/);
  assert.match(replies[0], /Available models:\ngpt-5\.4-codex/);
});

test('/thinking lists codex-app reasoning efforts from app-server metadata', async () => {
  const handlers = new Map();
  const replies = [];
  const effortCalls = [];

  registerSettingsCommands({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    buildTopicKey: () => '1:77',
    clearAgentOverride: () => {},
    clearModelOverride: (models) => ({ hadOverride: false, nextModels: models }),
    clearThreadForAgent: () => {},
    curateMemory: async () => {},
    execLocal: async () => '',
    extractCommandValue: () => '',
    getAgent,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getAgentOverride: () => 'codex-app',
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({ 'codex-app': 'gpt-5.4-codex' }),
    getGlobalServiceTiers: () => ({}),
    getGlobalThinking: () => null,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    listAgentModels: async () => '',
    listAgentReasoningEfforts: async (agentId, modelId) => {
      effortCalls.push({ agentId, modelId });
      return 'minimal\nlow\nmedium\nhigh';
    },
    normalizeAgent: (value) => value,
    normalizeTopicId: (value) => value,
    persistAgentOverrides: async () => {},
    persistMemory: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalModels: () => {},
    setGlobalServiceTiers: () => {},
    setGlobalThinking: () => {},
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async () => {},
    wrapCommandWithPty: (value) => value,
  });

  const handler = handlers.get('thinking');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/thinking', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.deepEqual(effortCalls, [
    { agentId: 'codex-app', modelId: 'gpt-5.4-codex' },
  ]);
  assert.match(replies[0], /No reasoning effort set/);
  assert.match(replies[0], /Available reasoning efforts:\nminimal\nlow\nmedium\nhigh/);
});

test('/thinking persists the selected reasoning effort', async () => {
  const handlers = new Map();
  const replies = [];
  const persisted = [];
  let thinking = null;

  registerSettingsCommands({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    buildTopicKey: () => '1:77',
    clearAgentOverride: () => {},
    clearModelOverride: (models) => ({ hadOverride: false, nextModels: models }),
    clearThreadForAgent: () => {},
    curateMemory: async () => {},
    execLocal: async () => '',
    extractCommandValue: () => 'high',
    getAgent,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getAgentOverride: () => 'codex-app',
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({}),
    getGlobalServiceTiers: () => ({}),
    getGlobalThinking: () => thinking,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    listAgentModels: async () => '',
    listAgentReasoningEfforts: async () => '',
    normalizeAgent: (value) => value,
    normalizeTopicId: (value) => value,
    persistAgentOverrides: async () => {},
    persistMemory: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalModels: () => {},
    setGlobalServiceTiers: () => {},
    setGlobalThinking: (value) => {
      thinking = value;
    },
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async (patch) => {
      persisted.push(patch);
    },
    wrapCommandWithPty: (value) => value,
  });

  const handler = handlers.get('thinking');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/thinking high', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.equal(thinking, 'high');
  assert.deepEqual(persisted, [{ thinking: 'high' }]);
  assert.match(replies[0], /Reasoning effort set to high/);
});

test('/fast toggles codex-app service tier between fast and flex', async () => {
  const handlers = new Map();
  const replies = [];
  let serviceTiers = {};

  registerSettingsCommands({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    buildTopicKey: () => '1:77',
    clearAgentOverride: () => {},
    clearModelOverride: (models) => ({ hadOverride: false, nextModels: models }),
    clearThreadForAgent: () => {},
    curateMemory: async () => {},
    execLocal: async () => '',
    extractCommandValue: () => '',
    getAgent,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getAgentOverride: () => 'codex-app',
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({}),
    getGlobalServiceTiers: () => serviceTiers,
    getGlobalThinking: () => null,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    listAgentModels: async () => '',
    normalizeAgent: (value) => value,
    normalizeTopicId: (value) => value,
    persistAgentOverrides: async () => {},
    persistMemory: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalModels: () => {},
    setGlobalServiceTiers: (value) => {
      serviceTiers = value;
    },
    setGlobalThinking: () => {},
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async () => {},
    wrapCommandWithPty: (value) => value,
  });

  const handler = handlers.get('fast');
  assert.ok(handler);

  const ctx = {
    chat: { id: 1 },
    message: { text: '/fast', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  };

  await handler(ctx);
  assert.equal(serviceTiers['codex-app'], 'fast');
  assert.match(replies[0], /service tier fast/);

  await handler(ctx);
  assert.equal(serviceTiers['codex-app'], 'flex');
  assert.match(replies[1], /service tier flex/);
});

test('/fast rejects agents other than codex-app', async () => {
  const handlers = new Map();
  const replies = [];

  registerSettingsCommands({
    bot: {
      command(name, handler) {
        handlers.set(name, handler);
      },
    },
    buildTopicKey: () => '1:77',
    clearAgentOverride: () => {},
    clearModelOverride: (models) => ({ hadOverride: false, nextModels: models }),
    clearThreadForAgent: () => {},
    curateMemory: async () => {},
    execLocal: async () => '',
    extractCommandValue: () => '',
    getAgent,
    getAgentLabel: (agentId) => getAgent(agentId).label,
    getAgentOverride: () => 'codex',
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({}),
    getGlobalServiceTiers: () => ({}),
    getGlobalThinking: () => null,
    getTopicId: (ctx) => ctx.message.message_thread_id,
    isKnownAgent: () => true,
    isModelResetCommand: () => false,
    listAgentModels: async () => '',
    normalizeAgent: (value) => value,
    normalizeTopicId: (value) => value,
    persistAgentOverrides: async () => {},
    persistMemory: async () => {},
    persistThreads: async () => {},
    replyWithError: async () => {},
    setAgentOverride: () => {},
    setGlobalAgent: () => {},
    setGlobalModels: () => {},
    setGlobalServiceTiers: () => {},
    setGlobalThinking: () => {},
    setMemoryEventsSinceCurate: () => {},
    startTyping: () => () => {},
    threadTurns: new Map(),
    updateConfig: async () => {},
    wrapCommandWithPty: (value) => value,
  });

  const handler = handlers.get('fast');
  assert.ok(handler);

  await handler({
    chat: { id: 1 },
    message: { text: '/fast', message_thread_id: 77 },
    reply: async (text) => {
      replies.push(text);
    },
  });

  assert.match(replies[0], /only supported for codex-app/i);
});

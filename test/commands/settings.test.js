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

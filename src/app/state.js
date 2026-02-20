const { buildThreadKey, normalizeTopicId } = require('../thread-store');

function createAppState({ defaultAgent }) {
  return {
    queues: new Map(),
    threads: new Map(),
    threadsPersist: Promise.resolve(),
    agentOverrides: new Map(),
    agentOverridesPersist: Promise.resolve(),
    memoryPersist: Promise.resolve(),
    threadTurns: new Map(),
    lastScriptOutputs: new Map(),
    memoryEventsSinceCurate: 0,
    globalThinking: undefined,
    globalAgent: defaultAgent,
    globalModels: {},
    cronDefaultChatId: null,
    cronScheduler: null,
    shutdownStarted: false,
  };
}

function persistThreads(state, saveThreads) {
  state.threadsPersist = state.threadsPersist
    .catch(() => {})
    .then(() => saveThreads(state.threads));
  return state.threadsPersist;
}

function persistAgentOverrides(state, saveAgentOverrides) {
  state.agentOverridesPersist = state.agentOverridesPersist
    .catch(() => {})
    .then(() => saveAgentOverrides(state.agentOverrides));
  return state.agentOverridesPersist;
}

function persistMemory(state, task) {
  state.memoryPersist = state.memoryPersist.catch(() => {}).then(task);
  return state.memoryPersist;
}

function resolveEffectiveAgentId(state, getAgentOverride, chatId, topicId, overrideAgentId) {
  return (
    overrideAgentId ||
    getAgentOverride(state.agentOverrides, chatId, topicId) ||
    state.globalAgent
  );
}

function buildMemoryThreadKey(chatId, topicId, agentId) {
  return buildThreadKey(chatId, normalizeTopicId(topicId), agentId);
}

module.exports = {
  buildMemoryThreadKey,
  createAppState,
  persistAgentOverrides,
  persistMemory,
  persistThreads,
  resolveEffectiveAgentId,
};

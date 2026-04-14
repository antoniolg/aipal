const { normalizeTelegramTopicId } = require('./telegram-topics');

const DEFAULT_MAX_ENTRIES = 500;

function buildReplyContextKey(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

function createReplyContextStore(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const entries = new Map();

  function pruneIfNeeded() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  function registerReplyContext({ agentId, chatId, contextKey, messageId, topicId }) {
    if (!chatId || !messageId || !agentId || !contextKey) return;
    const key = buildReplyContextKey(chatId, messageId);
    entries.set(key, {
      agentId: String(agentId),
      contextKey: String(contextKey),
      createdAt: Date.now(),
      topicId: normalizeTelegramTopicId(topicId),
    });
    pruneIfNeeded();
  }

  function resolveReplyContext({ agentId, chatId, messageId, topicId }) {
    if (!chatId || !messageId || !agentId) return null;
    const entry = entries.get(buildReplyContextKey(chatId, messageId));
    if (!entry) return null;
    if (entry.agentId !== String(agentId)) return null;

    const requestedTopicId = normalizeTelegramTopicId(topicId);
    if (entry.topicId !== requestedTopicId) return null;
    return entry;
  }

  return {
    registerReplyContext,
    resolveReplyContext,
  };
}

module.exports = {
  buildReplyContextKey,
  createReplyContextStore,
};

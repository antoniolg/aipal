function normalizeTopicId(topicId) {
  if (topicId === undefined || topicId === null || topicId === '') {
    return 'root';
  }
  return String(topicId);
}

function normalizeContextKey(contextKey) {
  const value = String(contextKey || '').trim();
  if (!value) return '';
  return `ctx:${value}`;
}

function resolveThreadTopicId(topicId, contextKey) {
  const normalizedContext = normalizeContextKey(contextKey);
  if (normalizedContext) return normalizedContext;
  return normalizeTopicId(topicId);
}

function buildTopicKey(chatId, topicId) {
  return `${String(chatId)}:${normalizeTopicId(topicId)}`;
}

function buildThreadKey(chatId, topicId, agentId, contextKey) {
  return `${String(chatId)}:${resolveThreadTopicId(topicId, contextKey)}:${agentId}`;
}

function getLegacyThreadKey(chatId, agentId) {
  return `${String(chatId)}:${agentId}`;
}

function getLegacyChatKey(chatId) {
  return String(chatId);
}

function resolveThreadId(threads, chatId, topicId, agentId, contextKey) {
  const normalizedTopic = normalizeTopicId(topicId);
  const resolvedTopic = resolveThreadTopicId(normalizedTopic, contextKey);
  const threadKey = buildThreadKey(chatId, resolvedTopic, agentId);
  const direct = threads.get(threadKey);
  if (direct) {
    return { threadKey, threadId: direct, migrated: false };
  }

  if (resolvedTopic !== 'root') {
    return { threadKey, threadId: undefined, migrated: false };
  }

  const legacyKey = getLegacyThreadKey(chatId, agentId);
  const legacy = threads.get(legacyKey);
  if (legacy) {
    threads.set(threadKey, legacy);
    threads.delete(legacyKey);
    return { threadKey, threadId: legacy, migrated: true };
  }

  const legacyChatKey = getLegacyChatKey(chatId);
  const legacyChat = threads.get(legacyChatKey);
  if (legacyChat) {
    threads.set(threadKey, legacyChat);
    threads.delete(legacyChatKey);
    return { threadKey, threadId: legacyChat, migrated: true };
  }

  return { threadKey, threadId: undefined, migrated: false };
}

function clearThreadForAgent(threads, chatId, topicId, agentId) {
  const normalizedTopic = normalizeTopicId(topicId);
  const threadKey = buildThreadKey(chatId, normalizedTopic, agentId);
  const removed = threads.delete(threadKey);

  if (normalizedTopic === 'root') {
    const removedLegacy = threads.delete(getLegacyThreadKey(chatId, agentId));
    const removedLegacyChat = threads.delete(getLegacyChatKey(chatId));
    return removed || removedLegacy || removedLegacyChat;
  }

  return removed;
}

module.exports = {
  buildThreadKey,
  buildTopicKey,
  clearThreadForAgent,
  normalizeContextKey,
  normalizeTopicId,
  resolveThreadId,
  resolveThreadTopicId,
};

function buildThreadKey(chatId, agentId) {
  return `${String(chatId)}:${agentId}`;
}

function getLegacyThreadKey(chatId) {
  return String(chatId);
}

function resolveThreadId(threads, chatId, agentId) {
  const threadKey = buildThreadKey(chatId, agentId);
  const direct = threads.get(threadKey);
  if (direct) {
    return { threadKey, threadId: direct, migrated: false };
  }
  const legacyKey = getLegacyThreadKey(chatId);
  const legacy = threads.get(legacyKey);
  if (legacy) {
    threads.set(threadKey, legacy);
    threads.delete(legacyKey);
    return { threadKey, threadId: legacy, migrated: true };
  }
  return { threadKey, threadId: undefined, migrated: false };
}

function clearThreadForAgent(threads, chatId, agentId) {
  const threadKey = buildThreadKey(chatId, agentId);
  const legacyKey = getLegacyThreadKey(chatId);
  const removed = threads.delete(threadKey);
  const removedLegacy = threads.delete(legacyKey);
  return removed || removedLegacy;
}

module.exports = {
  buildThreadKey,
  clearThreadForAgent,
  resolveThreadId,
};

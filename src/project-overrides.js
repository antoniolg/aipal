const { buildTopicKey } = require('./thread-store');

function getProjectOverrideKey(chatId, topicId) {
  return buildTopicKey(chatId, topicId);
}

function normalizeProjectPath(projectPath) {
  const value = String(projectPath || '').trim();
  return value || undefined;
}

function getProjectOverride(overrides, chatId, topicId) {
  return overrides.get(getProjectOverrideKey(chatId, topicId));
}

function setProjectOverride(overrides, chatId, topicId, projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) {
    throw new Error('projectPath is required');
  }
  const key = getProjectOverrideKey(chatId, topicId);
  overrides.set(key, normalized);
  return key;
}

function clearProjectOverride(overrides, chatId, topicId) {
  return overrides.delete(getProjectOverrideKey(chatId, topicId));
}

module.exports = {
  clearProjectOverride,
  getProjectOverride,
  getProjectOverrideKey,
  normalizeProjectPath,
  setProjectOverride,
};

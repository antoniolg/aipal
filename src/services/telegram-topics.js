const GENERAL_FORUM_TOPIC_ID = 1;

function normalizeTelegramTopicId(topicId) {
  if (topicId === undefined || topicId === null || topicId === '') return null;
  const numeric = Number(topicId);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return String(topicId);
}

function isGeneralForumTopic(topicId) {
  return normalizeTelegramTopicId(topicId) === GENERAL_FORUM_TOPIC_ID;
}

function buildTelegramThreadExtra({ topicId, isTopicMessage, forceTopic = false } = {}) {
  const normalizedTopicId = normalizeTelegramTopicId(topicId);
  if (!normalizedTopicId || isGeneralForumTopic(normalizedTopicId)) {
    return {};
  }
  if (!forceTopic && !isTopicMessage) {
    return {};
  }
  return { message_thread_id: normalizedTopicId };
}

function getTelegramMessageContext(message) {
  return {
    topicId: normalizeTelegramTopicId(message?.message_thread_id),
    isTopicMessage: Boolean(message?.is_topic_message),
  };
}

module.exports = {
  GENERAL_FORUM_TOPIC_ID,
  buildTelegramThreadExtra,
  getTelegramMessageContext,
  isGeneralForumTopic,
  normalizeTelegramTopicId,
};

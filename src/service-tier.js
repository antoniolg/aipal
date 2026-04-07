function normalizeServiceTier(value) {
  return String(value || '').trim().toLowerCase() === 'fast' ? 'fast' : undefined;
}

function formatServiceTierLabel(value) {
  return normalizeServiceTier(value) || 'default';
}

function buildNextServiceTiers(current, agentId, nextTier) {
  const next = { ...(current || {}) };
  const normalized = normalizeServiceTier(nextTier);
  if (normalized) {
    next[agentId] = normalized;
  } else {
    delete next[agentId];
  }
  return next;
}

module.exports = {
  buildNextServiceTiers,
  formatServiceTierLabel,
  normalizeServiceTier,
};

const DEFAULT_CRON_RUN_HISTORY_LIMIT = 20;
const DEFAULT_CRON_ALERT_HISTORY_LIMIT = 10;

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createEmptyCronState() {
  return { lastTickAt: null, jobs: {} };
}

function normalizePendingRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (!run.scheduledAt || !run.runAfter) return null;
  return {
    scheduledAt: String(run.scheduledAt),
    runAfter: String(run.runAfter),
    attempt: normalizePositiveInteger(run.attempt, 1),
    reason: String(run.reason || 'scheduled'),
  };
}

function normalizeRecentRun(entry) {
  if (!entry || typeof entry !== 'object' || !entry.scheduledAt) return null;
  return {
    scheduledAt: String(entry.scheduledAt),
    runAfter:
      typeof entry.runAfter === 'string' ? entry.runAfter : String(entry.scheduledAt),
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : null,
    finishedAt: typeof entry.finishedAt === 'string' ? entry.finishedAt : null,
    attempt: normalizePositiveInteger(entry.attempt, 1),
    maxAttempts: normalizePositiveInteger(
      entry.maxAttempts,
      normalizePositiveInteger(entry.attempt, 1)
    ),
    reason: String(entry.reason || 'scheduled'),
    status: typeof entry.status === 'string' ? entry.status : 'running',
    error: typeof entry.error === 'string' ? entry.error : null,
  };
}

function getRecentRunSortTime(entry) {
  return (
    parseTimestamp(entry.finishedAt)?.getTime()
    || parseTimestamp(entry.startedAt)?.getTime()
    || parseTimestamp(entry.runAfter)?.getTime()
    || parseTimestamp(entry.scheduledAt)?.getTime()
    || 0
  );
}

function sortRecentRuns(runs) {
  runs.sort(
    (left, right) => getRecentRunSortTime(left) - getRecentRunSortTime(right)
  );
}

function normalizeJobState(jobState) {
  return {
    lastScheduledAt:
      typeof jobState?.lastScheduledAt === 'string' ? jobState.lastScheduledAt : null,
    pendingRuns: Array.isArray(jobState?.pendingRuns)
      ? jobState.pendingRuns.map(normalizePendingRun).filter(Boolean)
      : [],
    runningRun: normalizePendingRun(jobState?.runningRun),
    lastStartedAt:
      typeof jobState?.lastStartedAt === 'string' ? jobState.lastStartedAt : null,
    lastFinishedAt:
      typeof jobState?.lastFinishedAt === 'string' ? jobState.lastFinishedAt : null,
    lastSuccessAt:
      typeof jobState?.lastSuccessAt === 'string' ? jobState.lastSuccessAt : null,
    lastFailedAt:
      typeof jobState?.lastFailedAt === 'string' ? jobState.lastFailedAt : null,
    lastStatus:
      typeof jobState?.lastStatus === 'string' ? jobState.lastStatus : null,
    lastError:
      typeof jobState?.lastError === 'string' ? jobState.lastError : null,
    lastMissedAlertAt:
      typeof jobState?.lastMissedAlertAt === 'string'
        ? jobState.lastMissedAlertAt
        : null,
    recentRuns: Array.isArray(jobState?.recentRuns)
      ? jobState.recentRuns.map(normalizeRecentRun).filter(Boolean)
      : [],
    deadLetterRuns: Array.isArray(jobState?.deadLetterRuns)
      ? jobState.deadLetterRuns.map(normalizeRecentRun).filter(Boolean)
      : [],
  };
}

function clonePendingRun(run) {
  return {
    scheduledAt: run.scheduledAt,
    runAfter: run.runAfter,
    attempt: run.attempt,
    reason: run.reason,
  };
}

function sortPendingRuns(runs) {
  runs.sort((left, right) => {
    const runAfterDiff =
      new Date(left.runAfter).getTime() - new Date(right.runAfter).getTime();
    if (runAfterDiff !== 0) return runAfterDiff;
    return new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime();
  });
}

function appendRecentRun(
  jobState,
  entry,
  limit = DEFAULT_CRON_RUN_HISTORY_LIMIT
) {
  const normalized = normalizeRecentRun(entry);
  if (!normalized) return null;
  jobState.recentRuns.push(normalized);
  sortRecentRuns(jobState.recentRuns);
  if (jobState.recentRuns.length > limit) {
    jobState.recentRuns.splice(0, jobState.recentRuns.length - limit);
  }
  return normalized;
}

function updateRecentRun(jobState, run, patch = {}) {
  const index = [...jobState.recentRuns]
    .reverse()
    .findIndex(
      (entry) =>
        entry.scheduledAt === run.scheduledAt
        && entry.attempt === run.attempt
        && (!entry.finishedAt || patch.finishedAt)
    );

  if (index === -1) {
    return appendRecentRun(jobState, { ...run, ...patch });
  }

  const actualIndex = jobState.recentRuns.length - 1 - index;
  const nextEntry = normalizeRecentRun({
    ...jobState.recentRuns[actualIndex],
    ...patch,
  });
  jobState.recentRuns[actualIndex] = nextEntry;
  sortRecentRuns(jobState.recentRuns);
  return nextEntry;
}

function appendDeadLetterRun(
  jobState,
  entry,
  limit = DEFAULT_CRON_ALERT_HISTORY_LIMIT
) {
  const normalized = normalizeRecentRun(entry);
  if (!normalized) return null;
  normalized.status = 'dead_letter';
  jobState.deadLetterRuns.push(normalized);
  sortRecentRuns(jobState.deadLetterRuns);
  if (jobState.deadLetterRuns.length > limit) {
    jobState.deadLetterRuns.splice(0, jobState.deadLetterRuns.length - limit);
  }
  return normalized;
}

module.exports = {
  DEFAULT_CRON_ALERT_HISTORY_LIMIT,
  DEFAULT_CRON_RUN_HISTORY_LIMIT,
  appendDeadLetterRun,
  appendRecentRun,
  clonePendingRun,
  createEmptyCronState,
  normalizeJobState,
  normalizePendingRun,
  normalizeRecentRun,
  parseTimestamp,
  sortPendingRuns,
  updateRecentRun,
};

const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { CONFIG_DIR } = require('../config-store');

const SCHEDULED_RUNS_PATH = path.join(CONFIG_DIR, 'scheduled-runs.json');
const DEFAULT_SCHEDULED_RUN_MAX_ATTEMPTS = 3;
const DEFAULT_SCHEDULED_RUN_RETRY_DELAY_SECONDS = 30;
const DEFAULT_SCHEDULED_RUN_RETRY_BACKOFF_FACTOR = 2;

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createEmptyScheduledRunsState() {
  return { runs: [] };
}

function normalizeScheduledRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (!run.id || !run.runAt || !run.prompt) return null;

  return {
    id: String(run.id),
    runAt: String(run.runAt),
    runAfter:
      typeof run.runAfter === 'string' ? run.runAfter : String(run.runAt),
    prompt: String(run.prompt),
    chatId:
      run.chatId === undefined || run.chatId === null ? null : Number(run.chatId),
    topicId:
      run.topicId === undefined || run.topicId === null ? null : Number(run.topicId),
    agent: typeof run.agent === 'string' ? run.agent : null,
    status: typeof run.status === 'string' ? run.status : 'pending',
    attempt: normalizePositiveInteger(run.attempt, 0),
    maxAttempts: normalizePositiveInteger(
      run.maxAttempts,
      DEFAULT_SCHEDULED_RUN_MAX_ATTEMPTS
    ),
    retryDelaySeconds: normalizePositiveInteger(
      run.retryDelaySeconds,
      DEFAULT_SCHEDULED_RUN_RETRY_DELAY_SECONDS
    ),
    retryBackoffFactor: normalizePositiveNumber(
      run.retryBackoffFactor,
      DEFAULT_SCHEDULED_RUN_RETRY_BACKOFF_FACTOR
    ),
    lastError: typeof run.lastError === 'string' ? run.lastError : null,
    lastStartedAt:
      typeof run.lastStartedAt === 'string' ? run.lastStartedAt : null,
    lastFinishedAt:
      typeof run.lastFinishedAt === 'string' ? run.lastFinishedAt : null,
    createdAt: typeof run.createdAt === 'string' ? run.createdAt : null,
    source: typeof run.source === 'string' ? run.source : null,
  };
}

async function loadScheduledRuns() {
  try {
    const raw = await fs.readFile(SCHEDULED_RUNS_PATH, 'utf8');
    if (!raw.trim()) return createEmptyScheduledRunsState();
    const parsed = JSON.parse(raw);
    return {
      runs: Array.isArray(parsed?.runs)
        ? parsed.runs.map(normalizeScheduledRun).filter(Boolean)
        : [],
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return createEmptyScheduledRunsState();
    console.warn('Failed to load scheduled-runs.json:', err);
    return createEmptyScheduledRunsState();
  }
}

async function saveScheduledRuns(state) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = `${SCHEDULED_RUNS_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, SCHEDULED_RUNS_PATH);
}

async function mutateScheduledRuns(mutator) {
  const state = await loadScheduledRuns();
  const result = await mutator(state);
  await saveScheduledRuns(state);
  return result;
}

function sortScheduledRuns(runs) {
  runs.sort((left, right) => {
    const leftTs =
      parseTimestamp(left.runAfter)?.getTime()
      || parseTimestamp(left.runAt)?.getTime()
      || 0;
    const rightTs =
      parseTimestamp(right.runAfter)?.getTime()
      || parseTimestamp(right.runAt)?.getTime()
      || 0;
    return leftTs - rightTs;
  });
}

function buildScheduledRun(params = {}, options = {}) {
  const currentTime = options.now ? options.now() : new Date();
  const requestedDate = parseTimestamp(params.runAt);
  if (!requestedDate) {
    throw new Error('runAt must be a valid ISO-8601 date/time.');
  }

  const runAfterDate =
    requestedDate.getTime() < currentTime.getTime() ? currentTime : requestedDate;
  const prompt = String(params.prompt || '').trim();
  if (!prompt) {
    throw new Error('prompt is required.');
  }

  return normalizeScheduledRun({
    id: params.id || `once-${randomUUID()}`,
    runAt: requestedDate.toISOString(),
    runAfter: runAfterDate.toISOString(),
    prompt,
    chatId: params.chatId ?? null,
    topicId: params.topicId ?? null,
    agent: params.agent || null,
    status: 'pending',
    attempt: 0,
    maxAttempts: params.maxAttempts,
    retryDelaySeconds: params.retryDelaySeconds,
    retryBackoffFactor: params.retryBackoffFactor,
    lastError: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    createdAt: currentTime.toISOString(),
    source: params.source || 'manual',
  });
}

async function createScheduledRun(params, options = {}) {
  const run = buildScheduledRun(params, options);
  await mutateScheduledRuns((state) => {
    state.runs.push(run);
    sortScheduledRuns(state.runs);
  });
  return run;
}

async function cancelScheduledRun(runId) {
  return mutateScheduledRuns((state) => {
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run) return null;
    if (['succeeded', 'dead_letter', 'cancelled'].includes(run.status)) {
      return run;
    }
    run.status = 'cancelled';
    run.lastFinishedAt = new Date().toISOString();
    return run;
  });
}

function listScheduledRuns(runs, filter = {}) {
  const items = Array.isArray(runs) ? runs.slice() : [];
  const status = filter.status || null;
  return items
    .filter((run) => !status || run.status === status)
    .sort((left, right) => {
      const leftTs =
        parseTimestamp(left.runAfter)?.getTime()
        || parseTimestamp(left.runAt)?.getTime()
        || 0;
      const rightTs =
        parseTimestamp(right.runAfter)?.getTime()
        || parseTimestamp(right.runAt)?.getTime()
        || 0;
      return leftTs - rightTs;
    });
}

function formatScheduledRun(run) {
  const target = [
    run.chatId === null ? null : `chat ${run.chatId}`,
    run.topicId === null ? null : `topic ${run.topicId}`,
  ]
    .filter(Boolean)
    .join(' / ');
  return [
    run.id,
    run.status,
    run.runAt,
    target || 'current chat',
    run.prompt,
  ].join(' | ');
}

module.exports = {
  DEFAULT_SCHEDULED_RUN_MAX_ATTEMPTS,
  DEFAULT_SCHEDULED_RUN_RETRY_BACKOFF_FACTOR,
  DEFAULT_SCHEDULED_RUN_RETRY_DELAY_SECONDS,
  SCHEDULED_RUNS_PATH,
  buildScheduledRun,
  cancelScheduledRun,
  createScheduledRun,
  formatScheduledRun,
  listScheduledRuns,
  loadScheduledRuns,
  mutateScheduledRuns,
  normalizeScheduledRun,
  parseTimestamp,
  saveScheduledRuns,
  sortScheduledRuns,
};

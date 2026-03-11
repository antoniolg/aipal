const cron = require('node-cron');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { CONFIG_DIR } = require('./config-store');
const { createCronMatcher } = require('./services/cron-matcher');
const {
  appendDeadLetterRun,
  appendRecentRun,
  clonePendingRun,
  createEmptyCronState,
  normalizeJobState,
  parseTimestamp,
  sortPendingRuns,
  updateRecentRun,
} = require('./services/cron-state');

const CRON_PATH = path.join(CONFIG_DIR, 'cron.json');
const CRON_STATE_PATH = path.join(CONFIG_DIR, 'cron-state.json');
const DEFAULT_TIMEZONE = 'Europe/Madrid';
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_CATCHUP_WINDOW_SECONDS = 10 * 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 30;
const DEFAULT_RETRY_BACKOFF_FACTOR = 2;

async function loadCronJobs() {
  try {
    const raw = await fs.readFile(CRON_PATH, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    console.warn('Failed to load cron.json:', err);
    return [];
  }
}

async function saveCronJobs(jobs) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CRON_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ jobs }, null, 2));
  await fs.rename(tmpPath, CRON_PATH);
}

async function loadCronState() {
  try {
    const raw = await fs.readFile(CRON_STATE_PATH, 'utf8');
    if (!raw.trim()) return createEmptyCronState();
    const parsed = JSON.parse(raw);
    const state = createEmptyCronState();
    if (typeof parsed?.lastTickAt === 'string') {
      state.lastTickAt = parsed.lastTickAt;
    }
    if (parsed && typeof parsed.jobs === 'object' && parsed.jobs) {
      for (const [jobId, jobState] of Object.entries(parsed.jobs)) {
        state.jobs[jobId] = normalizeJobState(jobState);
      }
    }
    return state;
  } catch (err) {
    if (err && err.code === 'ENOENT') return createEmptyCronState();
    console.warn('Failed to load cron-state.json:', err);
    return createEmptyCronState();
  }
}

async function saveCronState(state) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CRON_STATE_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
  await fs.rename(tmpPath, CRON_STATE_PATH);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCronJob(job) {
  return {
    ...job,
    timezone: job.timezone || DEFAULT_TIMEZONE,
    catchupWindowSeconds: normalizePositiveInteger(
      job.catchupWindowSeconds,
      DEFAULT_CATCHUP_WINDOW_SECONDS
    ),
    maxAttempts: normalizePositiveInteger(job.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    retryDelaySeconds: normalizePositiveInteger(
      job.retryDelaySeconds,
      DEFAULT_RETRY_DELAY_SECONDS
    ),
    retryBackoffFactor: normalizePositiveNumber(
      job.retryBackoffFactor,
      DEFAULT_RETRY_BACKOFF_FACTOR
    ),
  };
}

function buildCronTriggerPayload(job, defaultChatId, extraOptions = {}) {
  return {
    chatId: job.chatId || defaultChatId,
    prompt: job.prompt,
    options: {
      jobId: job.id,
      agent: job.agent,
      topicId: job.topicId,
      ...extraOptions,
    },
  };
}

function calculateRetryDelayMs(job, nextAttempt) {
  const multiplier = job.retryBackoffFactor ** Math.max(0, nextAttempt - 2);
  return Math.round(job.retryDelaySeconds * 1000 * multiplier);
}

function startCronScheduler(options = {}) {
  const {
    onTrigger,
    chatId,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onAlert = null,
  } = options;

  if (!onTrigger || !chatId) {
    console.warn('Cron scheduler requires onTrigger and chatId');
    return {
      tasks: new Map(),
      reload: async () => 0,
      stop: () => {},
      tick: async () => {},
    };
  }

  const tasks = new Map();
  let state = createEmptyCronState();
  let tickTimer = null;
  let stopped = false;
  let initialized = false;
  let initPromise = null;
  let tickPromise = Promise.resolve();
  let persistPromise = Promise.resolve();
  let alertPromise = Promise.resolve();

  function ensureJobState(jobId) {
    if (!state.jobs[jobId]) {
      state.jobs[jobId] = normalizeJobState({});
    }
    return state.jobs[jobId];
  }

  function queueStatePersist() {
    persistPromise = persistPromise
      .catch(() => {})
      .then(() => saveCronState(state))
      .catch((err) => console.warn('Failed to persist cron state:', err));
    return persistPromise;
  }

  function clearTickTimer() {
    if (tickTimer) {
      clearTimer(tickTimer);
      tickTimer = null;
    }
  }

  function scheduleNextTick(delayMs = pollIntervalMs) {
    if (stopped) return;
    clearTickTimer();
    tickTimer = setTimer(() => {
      void tick();
    }, delayMs);
    if (tickTimer && typeof tickTimer.unref === 'function') {
      tickTimer.unref();
    }
  }

  function enqueuePendingRun(runtime, pendingRun) {
    runtime.queue.push(clonePendingRun(pendingRun));
    sortPendingRuns(runtime.queue);
  }

  function buildAlertTarget(job) {
    return {
      chatId: job.chatId || chatId,
      topicId: job.topicId,
    };
  }

  function queueAlert(event) {
    if (typeof onAlert !== 'function' || !event) return Promise.resolve();
    alertPromise = alertPromise
      .catch(() => {})
      .then(() => onAlert(event))
      .catch((err) => console.warn('Failed to send cron alert:', err));
    return alertPromise;
  }

  async function finalizeRun(runtime, run, result) {
    const finishedAt = now().toISOString();
    const jobState = ensureJobState(runtime.job.id);
    jobState.runningRun = null;
    jobState.lastFinishedAt = finishedAt;

    if (!result || result.ok === false) {
      const error = result?.error instanceof Error
        ? result.error
        : new Error(String(result?.error || 'Cron job failed'));
      jobState.lastError = error.message;

      if (run.attempt < runtime.job.maxAttempts) {
        const nextAttempt = run.attempt + 1;
        const retryRun = {
          scheduledAt: run.scheduledAt,
          runAfter: new Date(
            now().getTime() + calculateRetryDelayMs(runtime.job, nextAttempt)
          ).toISOString(),
          attempt: nextAttempt,
          reason: 'retry',
        };
        jobState.pendingRuns.push(clonePendingRun(retryRun));
        sortPendingRuns(jobState.pendingRuns);
        enqueuePendingRun(runtime, retryRun);
        jobState.lastStatus = 'retry_scheduled';
        console.warn(
          `Cron job ${runtime.job.id} failed attempt ${run.attempt}/${runtime.job.maxAttempts}; retry ${nextAttempt} scheduled for ${retryRun.runAfter}`
        );
      } else {
        jobState.lastStatus = 'failed';
        jobState.lastFailedAt = finishedAt;
        console.error(
          `Cron job ${runtime.job.id} failed permanently after ${run.attempt} attempt(s):`,
          error.message
        );
        const deadLetterRun = appendDeadLetterRun(jobState, {
          scheduledAt: run.scheduledAt,
          runAfter: run.runAfter,
          startedAt: jobState.lastStartedAt,
          finishedAt,
          attempt: run.attempt,
          maxAttempts: runtime.job.maxAttempts,
          reason: run.reason,
          status: 'dead_letter',
          error: error.message,
        });
        updateRecentRun(jobState, run, {
          finishedAt,
          maxAttempts: runtime.job.maxAttempts,
          status: 'failed',
          error: error.message,
        });
        await queueStatePersist();
        await queueAlert({
          type: 'dead_letter',
          jobId: runtime.job.id,
          run: deadLetterRun,
          ...buildAlertTarget(runtime.job),
        });
        return;
      }

      updateRecentRun(jobState, run, {
        finishedAt,
        maxAttempts: runtime.job.maxAttempts,
        status: run.attempt < runtime.job.maxAttempts ? 'retry_scheduled' : 'failed',
        error: error.message,
      });

      await queueStatePersist();
      return;
    }

    jobState.lastStatus = 'succeeded';
    jobState.lastSuccessAt = finishedAt;
    jobState.lastError = null;
    updateRecentRun(jobState, run, {
      finishedAt,
      maxAttempts: runtime.job.maxAttempts,
      status: 'succeeded',
      error: null,
    });
    await queueStatePersist();
    console.info(
      `Cron job ${runtime.job.id} finished successfully at ${finishedAt}`
    );
  }

  async function executeReadyRun(runtime) {
    const currentRun = runtime.queue.shift();
    if (!currentRun) return;

    const jobState = ensureJobState(runtime.job.id);
    const pendingIndex = jobState.pendingRuns.findIndex(
      (run) =>
        run.scheduledAt === currentRun.scheduledAt
        && run.attempt === currentRun.attempt
        && run.runAfter === currentRun.runAfter
    );
    if (pendingIndex >= 0) {
      jobState.pendingRuns.splice(pendingIndex, 1);
    }

    jobState.runningRun = clonePendingRun(currentRun);
    jobState.lastStartedAt = now().toISOString();
    jobState.lastStatus = currentRun.attempt > 1 ? 'retrying' : 'running';
    appendRecentRun(jobState, {
      scheduledAt: currentRun.scheduledAt,
      runAfter: currentRun.runAfter,
      startedAt: jobState.lastStartedAt,
      attempt: currentRun.attempt,
      maxAttempts: runtime.job.maxAttempts,
      reason: currentRun.reason,
      status: currentRun.attempt > 1 ? 'retrying' : 'running',
    });
    const runningStatePersist = queueStatePersist();

    const payload = buildCronTriggerPayload(runtime.job, chatId, {
      scheduledAt: currentRun.scheduledAt,
      attempt: currentRun.attempt,
      maxAttempts: runtime.job.maxAttempts,
      triggerReason: currentRun.reason,
      notifyFailure: false,
    });

    let result;
    try {
      result = await onTrigger(payload.chatId, payload.prompt, payload.options);
    } catch (err) {
      result = { ok: false, error: err };
    }

    await runningStatePersist;
    await finalizeRun(runtime, currentRun, result);
  }

  function startReadyJobs() {
    for (const runtime of tasks.values()) {
      if (runtime.running || runtime.queue.length === 0) continue;
      const nextRun = runtime.queue[0];
      if (parseTimestamp(nextRun.runAfter)?.getTime() > now().getTime()) continue;

      runtime.running = true;
      runtime.processingPromise = executeReadyRun(runtime)
        .catch((err) => {
          console.error(`Cron job ${runtime.job.id} crashed during execution:`, err);
        })
        .finally(() => {
          runtime.running = false;
          runtime.processingPromise = null;
          if (!stopped) {
            startReadyJobs();
          }
        });
    }
  }

  function pruneState(validJobIds) {
    let changed = false;
    for (const jobId of Object.keys(state.jobs)) {
      if (validJobIds.has(jobId)) continue;
      delete state.jobs[jobId];
      changed = true;
    }
    return changed;
  }

  async function reload() {
    await ensureInitializedState();

    const jobs = await loadCronJobs();
    const validJobIds = new Set();
    const nextTasks = new Map();
    let stateChanged = false;

    for (const rawJob of jobs) {
      if (!rawJob.enabled) continue;
      if (!rawJob.id || !rawJob.cron || !rawJob.prompt) {
        console.warn('Invalid cron job, skipping:', rawJob);
        continue;
      }
      if (!cron.validate(rawJob.cron)) {
        console.warn(`Invalid cron expression for job ${rawJob.id}: ${rawJob.cron}`);
        continue;
      }

      const job = normalizeCronJob(rawJob);
      const previousRuntime = tasks.get(job.id);
      const jobState = ensureJobState(job.id);
      if (!previousRuntime && jobState.runningRun) {
        jobState.pendingRuns.unshift(clonePendingRun(jobState.runningRun));
        jobState.runningRun = null;
        sortPendingRuns(jobState.pendingRuns);
        stateChanged = true;
      }

      const runtime = {
        job,
        matcher: createCronMatcher(job.cron, job.timezone),
        queue: previousRuntime ? previousRuntime.queue : [],
        running: previousRuntime ? previousRuntime.running : false,
        processingPromise: previousRuntime ? previousRuntime.processingPromise : null,
      };

      if (!previousRuntime) {
        runtime.queue = jobState.pendingRuns.map(clonePendingRun);
        sortPendingRuns(runtime.queue);
      }

      nextTasks.set(job.id, runtime);
      validJobIds.add(job.id);
      console.info(`Cron scheduled: ${job.id} (${job.cron})`);
    }

    tasks.clear();
    for (const [jobId, runtime] of nextTasks) {
      tasks.set(jobId, runtime);
    }

    if (pruneState(validJobIds) || stateChanged) {
      await queueStatePersist();
    }

    startReadyJobs();
    return tasks.size;
  }

  function hasQueuedSlot(jobState, scheduledAt) {
    if (jobState.runningRun?.scheduledAt === scheduledAt) return true;
    return jobState.pendingRuns.some((run) => run.scheduledAt === scheduledAt);
  }

  function scanDueSlots(nowDate) {
    let changed = false;
    const alerts = [];

    for (const runtime of tasks.values()) {
      const jobState = ensureJobState(runtime.job.id);
      const catchupStart = new Date(
        nowDate.getTime() - runtime.job.catchupWindowSeconds * 1000
      );
      let cursor = parseTimestamp(jobState.lastScheduledAt);
      const lastTickAt = parseTimestamp(state.lastTickAt);
      const hasHistory =
        !!jobState.lastScheduledAt
        || !!jobState.lastStartedAt
        || !!jobState.lastSuccessAt
        || !!jobState.lastFailedAt
        || jobState.pendingRuns.length > 0
        || !!jobState.runningRun;
      if (!cursor) {
        if (lastTickAt) {
          cursor = new Date(
            Math.max(lastTickAt.getTime(), catchupStart.getTime()) - 1000
          );
        } else {
          cursor = hasHistory
            ? new Date(catchupStart.getTime() - 1000)
            : new Date(nowDate.getTime() - 1000);
        }
      } else if (cursor.getTime() < catchupStart.getTime()) {
        let firstMissedAt = null;
        let lastMissedAt = null;
        let missedCount = 0;
        let missedCursor = runtime.matcher.getNextMatch(cursor);
        while (missedCursor.getTime() < catchupStart.getTime()) {
          if (!firstMissedAt) firstMissedAt = missedCursor.toISOString();
          lastMissedAt = missedCursor.toISOString();
          missedCount += 1;
          missedCursor = runtime.matcher.getNextMatch(missedCursor);
        }
        if (
          missedCount > 0
          && (!jobState.lastMissedAlertAt
            || parseTimestamp(jobState.lastMissedAlertAt)?.getTime()
              < parseTimestamp(lastMissedAt)?.getTime())
        ) {
          jobState.lastMissedAlertAt = lastMissedAt;
          changed = true;
          alerts.push({
            type: 'missed_schedule',
            jobId: runtime.job.id,
            count: missedCount,
            firstMissedAt,
            lastMissedAt,
            catchupWindowSeconds: runtime.job.catchupWindowSeconds,
            ...buildAlertTarget(runtime.job),
          });
        }
        cursor = new Date(catchupStart.getTime() - 1000);
      }

      let nextRunAt = runtime.matcher.getNextMatch(cursor);
      while (nextRunAt.getTime() <= nowDate.getTime()) {
        const scheduledAt = nextRunAt.toISOString();
        jobState.lastScheduledAt = scheduledAt;
        if (!hasQueuedSlot(jobState, scheduledAt)) {
          const pendingRun = {
            scheduledAt,
            runAfter: scheduledAt,
            attempt: 1,
            reason:
              nextRunAt.getTime() < nowDate.getTime() ? 'catchup' : 'scheduled',
          };
          jobState.pendingRuns.push(clonePendingRun(pendingRun));
          sortPendingRuns(jobState.pendingRuns);
          enqueuePendingRun(runtime, pendingRun);
          changed = true;
          console.info(
            `Cron enqueued ${runtime.job.id} for ${scheduledAt} (${pendingRun.reason})`
          );
        }
        nextRunAt = runtime.matcher.getNextMatch(nextRunAt);
      }
    }

    return { changed, alerts };
  }

  async function ensureInitializedState() {
    if (initialized) return;
    state = await loadCronState();
    initialized = true;
  }

  async function runTick() {
    await ensureInitializedState();
    const currentTime = now();
    const { changed, alerts } = scanDueSlots(currentTime);
    const previousTickAt = state.lastTickAt;
    state.lastTickAt = currentTime.toISOString();
    const shouldPersistHeartbeat =
      !previousTickAt
      || previousTickAt.slice(0, 16) !== state.lastTickAt.slice(0, 16);
    if (changed || shouldPersistHeartbeat) {
      await queueStatePersist();
    }
    for (const alert of alerts) {
      await queueAlert(alert);
    }
    startReadyJobs();
  }

  async function tick() {
    tickPromise = tickPromise
      .catch(() => {})
      .then(runTick)
      .catch((err) => console.error('Cron tick failed:', err))
      .finally(() => {
        if (!stopped) {
          scheduleNextTick();
        }
      });
    return tickPromise;
  }

  function stop() {
    stopped = true;
    clearTickTimer();
  }

  async function initialize() {
    await ensureInitializedState();
    const count = await reload();
    console.info(`Cron scheduler started with ${count} job(s)`);
    await tick();
  }

  initPromise = initialize().catch((err) => {
    console.error('Failed to start cron scheduler:', err);
  });

  return {
    tasks,
    reload,
    stop,
    tick,
    ready: () => initPromise,
  };
}

module.exports = {
  CRON_PATH,
  CRON_STATE_PATH,
  loadCronJobs,
  saveCronJobs,
  loadCronState,
  saveCronState,
  buildCronTriggerPayload,
  startCronScheduler,
};

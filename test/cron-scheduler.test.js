const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadCronScheduler(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const modulePath = path.join(__dirname, '..', 'src', 'cron-scheduler.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function createManualClock(initialIso) {
  let current = new Date(initialIso);
  return {
    now() {
      return new Date(current);
    },
    set(iso) {
      current = new Date(iso);
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function createManualTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    setTimer(fn, delay) {
      const handle = { id: ++nextId };
      timers.set(handle.id, { fn, delay });
      return handle;
    },
    clearTimer(handle) {
      if (handle?.id) timers.delete(handle.id);
    },
    pendingCount() {
      return timers.size;
    },
  };
}

async function waitForSchedulerIdle(scheduler, rounds = 10) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    const running = Array.from(scheduler.tasks.values())
      .map((runtime) => runtime.processingPromise)
      .filter(Boolean);
    if (running.length === 0) return;
    await Promise.allSettled(running);
  }
}

test('loadCronJobs returns empty list when file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs } = loadCronScheduler(dir);
  const jobs = await loadCronJobs();
  assert.deepEqual(jobs, []);
});

test('saveCronJobs writes and loadCronJobs reads jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs, saveCronJobs, CRON_PATH } = loadCronScheduler(dir);

  const input = [
    { id: 'test', cron: '* * * * *', prompt: 'hi', enabled: true },
    { id: 'off', cron: '0 0 * * *', prompt: 'nope', enabled: false },
  ];
  await saveCronJobs(input);

  const loaded = await loadCronJobs();
  assert.deepEqual(loaded, input);

  const raw = await fs.readFile(CRON_PATH, 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: input });
});

test('buildCronTriggerPayload mirrors scheduler delivery fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { buildCronTriggerPayload } = loadCronScheduler(dir);

  const payload = buildCronTriggerPayload(
    {
      id: 'nightly-interests',
      prompt: 'run now',
      topicId: 2801,
      chatId: -1003608686125,
      agent: 'codex',
    },
    123456,
    {
      scheduledAt: '2026-03-10T10:00:00.000Z',
      attempt: 2,
    }
  );

  assert.deepEqual(payload, {
    chatId: -1003608686125,
    prompt: 'run now',
    options: {
      jobId: 'nightly-interests',
      agent: 'codex',
      topicId: 2801,
      scheduledAt: '2026-03-10T10:00:00.000Z',
      attempt: 2,
    },
  });
});

test('scheduler triggers the current slot on a fresh start', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:00:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'fresh-start',
      cron: '* * * * *',
      prompt: 'hello',
      enabled: true,
      timezone: 'UTC',
    },
  ]);

  const calls = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (chatId, prompt, options) => {
      calls.push({ chatId, prompt, options });
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, 123);
  assert.equal(calls[0].prompt, 'hello');
  assert.equal(calls[0].options.scheduledAt, '2026-03-10T10:00:00.000Z');
  assert.equal(calls[0].options.attempt, 1);
  assert.equal(calls[0].options.triggerReason, 'scheduled');
  assert.equal(timers.pendingCount(), 1);

  scheduler.stop();
});

test('scheduler catches up missed slots after downtime within the configured window', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, saveCronState, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:03:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'catchup',
      cron: '* * * * *',
      prompt: 'resume',
      enabled: true,
      timezone: 'UTC',
      catchupWindowSeconds: 600,
    },
  ]);

  await saveCronState({
    jobs: {
      catchup: {
        lastScheduledAt: '2026-03-10T10:00:00.000Z',
        lastSuccessAt: '2026-03-10T10:00:01.000Z',
      },
    },
  });

  const scheduledAts = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (_chatId, _prompt, options) => {
      scheduledAts.push(options.scheduledAt);
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);

  assert.deepEqual(scheduledAts, [
    '2026-03-10T10:01:00.000Z',
    '2026-03-10T10:02:00.000Z',
    '2026-03-10T10:03:00.000Z',
  ]);

  scheduler.stop();
});

test('scheduler catches up the first slot after wake even without prior job history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, saveCronState, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T09:19:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'wake-catchup',
      cron: '15 9 * * *',
      prompt: 'wake up',
      enabled: true,
      timezone: 'UTC',
      catchupWindowSeconds: 600,
    },
  ]);

  await saveCronState({
    lastTickAt: '2026-03-10T09:14:30.000Z',
    jobs: {},
  });

  const scheduledAts = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (_chatId, _prompt, options) => {
      scheduledAts.push(options.scheduledAt);
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);

  assert.deepEqual(scheduledAts, ['2026-03-10T09:15:00.000Z']);

  scheduler.stop();
});

test('scheduler retries failed runs with backoff and preserves pending retries on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const {
    loadCronState,
    saveCronJobs,
    startCronScheduler,
  } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:00:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'retry',
      cron: '* * * * *',
      prompt: 'retry me',
      enabled: true,
      timezone: 'UTC',
      maxAttempts: 3,
      retryDelaySeconds: 1,
    },
  ]);

  let attempts = 0;
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, error: new Error(`boom-${attempts}`) };
      }
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);
  assert.equal(attempts, 1);

  let state = await loadCronState();
  assert.equal(state.jobs.retry.pendingRuns.length, 1);
  assert.equal(state.jobs.retry.pendingRuns[0].attempt, 2);
  assert.equal(state.jobs.retry.recentRuns.length, 1);
  assert.equal(state.jobs.retry.recentRuns[0].status, 'retry_scheduled');

  clock.advance(1000);
  await scheduler.tick();
  await waitForSchedulerIdle(scheduler);
  assert.equal(attempts, 2);

  state = await loadCronState();
  assert.equal(state.jobs.retry.pendingRuns.length, 1);
  assert.equal(state.jobs.retry.pendingRuns[0].attempt, 3);
  assert.equal(state.jobs.retry.recentRuns.length, 2);
  assert.equal(state.jobs.retry.recentRuns[1].status, 'retry_scheduled');

  clock.advance(2000);
  await scheduler.tick();
  await waitForSchedulerIdle(scheduler);
  assert.equal(attempts, 3);

  state = await loadCronState();
  assert.equal(state.jobs.retry.pendingRuns.length, 0);
  assert.equal(state.jobs.retry.lastStatus, 'succeeded');
  assert.equal(state.jobs.retry.lastError, null);
  assert.equal(state.jobs.retry.recentRuns.length, 3);
  assert.equal(state.jobs.retry.recentRuns[2].status, 'succeeded');

  scheduler.stop();
});

test('scheduler sends a DLQ alert when retries are exhausted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronState, saveCronJobs, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:00:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'dlq',
      cron: '* * * * *',
      prompt: 'fail forever',
      enabled: true,
      timezone: 'UTC',
      maxAttempts: 2,
      retryDelaySeconds: 1,
    },
  ]);

  const alerts = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async () => ({ ok: false, error: new Error('boom') }),
    onAlert: async (event) => {
      alerts.push(event);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);
  assert.equal(alerts.length, 0);

  clock.advance(1000);
  await scheduler.tick();
  await waitForSchedulerIdle(scheduler);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'dead_letter');
  assert.equal(alerts[0].jobId, 'dlq');
  assert.equal(alerts[0].run.attempt, 2);
  assert.equal(alerts[0].run.status, 'dead_letter');

  const state = await loadCronState();
  assert.equal(state.jobs.dlq.pendingRuns.length, 0);
  assert.equal(state.jobs.dlq.deadLetterRuns.length, 1);
  assert.equal(state.jobs.dlq.deadLetterRuns[0].status, 'dead_letter');

  scheduler.stop();
});

test('scheduler resumes a persisted retry after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const {
    saveCronJobs,
    saveCronState,
    startCronScheduler,
  } = loadCronScheduler(dir);

  await saveCronJobs([
    {
      id: 'resume-retry',
      cron: '* * * * *',
      prompt: 'recover',
      enabled: true,
      timezone: 'UTC',
      maxAttempts: 3,
      retryDelaySeconds: 1,
    },
  ]);

  await saveCronState({
    jobs: {
      'resume-retry': {
        lastScheduledAt: '2026-03-10T10:00:00.000Z',
        pendingRuns: [
          {
            scheduledAt: '2026-03-10T10:00:00.000Z',
            runAfter: '2026-03-10T10:00:01.000Z',
            attempt: 2,
            reason: 'retry',
          },
        ],
      },
    },
  });

  const clock = createManualClock('2026-03-10T10:00:01.000Z');
  const timers = createManualTimers();
  const attempts = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (_chatId, _prompt, options) => {
      attempts.push(options.attempt);
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);

  assert.deepEqual(attempts, [2]);

  scheduler.stop();
});

test('scheduler alerts once when old slots fall outside the catch-up window', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, saveCronState, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:20:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'missed',
      cron: '* * * * *',
      prompt: 'recover',
      enabled: true,
      timezone: 'UTC',
      catchupWindowSeconds: 300,
    },
  ]);

  await saveCronState({
    jobs: {
      missed: {
        lastScheduledAt: '2026-03-10T10:00:00.000Z',
        lastSuccessAt: '2026-03-10T10:00:01.000Z',
      },
    },
  });

  const alerts = [];
  const scheduledAts = [];
  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (_chatId, _prompt, options) => {
      scheduledAts.push(options.scheduledAt);
      return { ok: true };
    },
    onAlert: async (event) => {
      alerts.push(event);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await waitForSchedulerIdle(scheduler);

  assert.deepEqual(scheduledAts, [
    '2026-03-10T10:15:00.000Z',
    '2026-03-10T10:16:00.000Z',
    '2026-03-10T10:17:00.000Z',
    '2026-03-10T10:18:00.000Z',
    '2026-03-10T10:19:00.000Z',
    '2026-03-10T10:20:00.000Z',
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'missed_schedule');
  assert.equal(alerts[0].count, 14);
  assert.equal(alerts[0].firstMissedAt, '2026-03-10T10:01:00.000Z');
  assert.equal(alerts[0].lastMissedAt, '2026-03-10T10:14:00.000Z');

  await scheduler.tick();
  await waitForSchedulerIdle(scheduler);
  assert.equal(alerts.length, 1);

  scheduler.stop();
});

test('scheduler never overlaps runs of the same job and drains them in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, saveCronState, startCronScheduler } = loadCronScheduler(dir);
  const clock = createManualClock('2026-03-10T10:01:00.000Z');
  const timers = createManualTimers();

  await saveCronJobs([
    {
      id: 'serial',
      cron: '* * * * *',
      prompt: 'queue me',
      enabled: true,
      timezone: 'UTC',
    },
  ]);

  await saveCronState({
    jobs: {
      serial: {
        lastScheduledAt: '2026-03-10T09:59:00.000Z',
        lastSuccessAt: '2026-03-10T09:59:01.000Z',
      },
    },
  });

  const started = [];
  let releaseFirst;
  const firstRunDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const scheduler = startCronScheduler({
    chatId: 123,
    now: () => clock.now(),
    onTrigger: async (_chatId, _prompt, options) => {
      started.push(options.scheduledAt);
      if (started.length === 1) {
        await firstRunDone;
      }
      return { ok: true };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  await Promise.resolve();

  assert.deepEqual(started, ['2026-03-10T10:00:00.000Z']);

  releaseFirst();
  await waitForSchedulerIdle(scheduler);

  assert.deepEqual(started, [
    '2026-03-10T10:00:00.000Z',
    '2026-03-10T10:01:00.000Z',
  ]);

  scheduler.stop();
});

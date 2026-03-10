const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadModules(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const runsPath = path.join(__dirname, '..', 'src', 'services', 'scheduled-runs.js');
  const schedulerPath = path.join(__dirname, '..', 'src', 'one-shot-scheduler.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(runsPath)];
  delete require.cache[require.resolve(schedulerPath)];
  return {
    ...require(runsPath),
    ...require(schedulerPath),
  };
}

function createManualClock(initialIso) {
  let current = new Date(initialIso);
  return {
    now() {
      return new Date(current);
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
  };
}

test('createScheduledRun persists a pending one-shot run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-once-'));
  const { createScheduledRun, loadScheduledRuns } = loadModules(dir);

  const run = await createScheduledRun({
    runAt: '2026-03-20T09:30:00+01:00',
    prompt: 'Ping me later',
    chatId: 123,
    topicId: 456,
    agent: 'codex',
  });

  const state = await loadScheduledRuns();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].id, run.id);
  assert.equal(state.runs[0].status, 'pending');
});

test('one-shot scheduler executes due runs and retries to DLQ', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-once-'));
  const {
    createScheduledRun,
    loadScheduledRuns,
    startOneShotScheduler,
  } = loadModules(dir);
  const clock = createManualClock('2026-03-20T08:30:00.000Z');
  const timers = createManualTimers();

  await createScheduledRun(
    {
      runAt: '2026-03-20T08:30:00.000Z',
      prompt: 'Run once',
      chatId: 123,
      maxAttempts: 2,
      retryDelaySeconds: 1,
    },
    { now: () => clock.now() }
  );

  const alerts = [];
  let attempts = 0;
  const scheduler = startOneShotScheduler({
    now: () => clock.now(),
    onTrigger: async () => {
      attempts += 1;
      return { ok: false, error: new Error(`boom-${attempts}`) };
    },
    onAlert: async (event) => {
      alerts.push(event);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.ready();
  assert.equal(attempts, 1);

  clock.advance(1000);
  await scheduler.tick();
  assert.equal(attempts, 2);

  const state = await loadScheduledRuns();
  assert.equal(state.runs[0].status, 'dead_letter');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'scheduled_run_dead_letter');

  scheduler.stop();
});

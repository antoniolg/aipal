const {
  loadScheduledRuns,
  mutateScheduledRuns,
  parseTimestamp,
} = require('./services/scheduled-runs');

function calculateRetryDelayMs(run, nextAttempt) {
  const multiplier = run.retryBackoffFactor ** Math.max(0, nextAttempt - 2);
  return Math.round(run.retryDelaySeconds * 1000 * multiplier);
}

function startOneShotScheduler(options = {}) {
  const {
    onTrigger,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    pollIntervalMs = 1000,
    onAlert = null,
    defaultChatId = null,
  } = options;

  if (!onTrigger) {
    console.warn('One-shot scheduler requires onTrigger');
    return {
      stop: () => {},
      tick: async () => {},
      ready: async () => {},
    };
  }

  let stopped = false;
  let tickTimer = null;
  let tickPromise = Promise.resolve();

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

  async function queueAlert(event) {
    if (typeof onAlert !== 'function' || !event) return;
    try {
      await onAlert(event);
    } catch (err) {
      console.warn('Failed to send one-shot schedule alert:', err);
    }
  }

  async function pickDueRun(currentTime) {
    return mutateScheduledRuns((state) => {
      const dueRuns = state.runs
        .filter((run) =>
          ['pending', 'retry_scheduled'].includes(run.status)
          && parseTimestamp(run.runAfter)?.getTime() <= currentTime.getTime()
        )
        .sort(
          (left, right) =>
            parseTimestamp(left.runAfter).getTime()
            - parseTimestamp(right.runAfter).getTime()
        );

      const run = dueRuns[0];
      if (!run) return null;

      run.attempt += 1;
      run.status = run.attempt > 1 ? 'retrying' : 'running';
      run.lastStartedAt = currentTime.toISOString();
      run.lastError = null;
      return { ...run };
    });
  }

  async function finishRun(run, result) {
    const finishedAt = now().toISOString();
    let alertEvent = null;

    await mutateScheduledRuns((state) => {
      const entry = state.runs.find((item) => item.id === run.id);
      if (!entry) return;

      entry.lastFinishedAt = finishedAt;
      if (result?.ok !== false) {
        entry.status = 'succeeded';
        entry.lastError = null;
        return;
      }

      const error = result?.error instanceof Error
        ? result.error
        : new Error(String(result?.error || 'Scheduled run failed'));
      entry.lastError = error.message;

      if (entry.attempt < entry.maxAttempts) {
        const nextAttempt = entry.attempt + 1;
        entry.status = 'retry_scheduled';
        entry.runAfter = new Date(
          now().getTime() + calculateRetryDelayMs(entry, nextAttempt)
        ).toISOString();
        return;
      }

      entry.status = 'dead_letter';
      alertEvent = {
        type: 'scheduled_run_dead_letter',
        runId: entry.id,
        run: { ...entry },
        chatId: entry.chatId || defaultChatId,
        topicId: entry.topicId,
      };
    });

    if (alertEvent) {
      await queueAlert(alertEvent);
    }
  }

  async function processDueRuns() {
    const currentTime = now();
    while (!stopped) {
      const run = await pickDueRun(currentTime);
      if (!run) return;

      const chatId = run.chatId || defaultChatId;
      if (!chatId) {
        await finishRun(run, {
          ok: false,
          error: new Error('Scheduled run has no target chatId configured'),
        });
        continue;
      }

      let result;
      try {
        result = await onTrigger(chatId, run.prompt, {
          topicId: run.topicId,
          agent: run.agent,
          notifyFailure: false,
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
          triggerReason: run.attempt > 1 ? 'retry' : 'scheduled_once',
          scheduledAt: run.runAt,
          scheduledRunId: run.id,
        });
      } catch (err) {
        result = { ok: false, error: err };
      }

      await finishRun(run, result);
    }
  }

  async function runTick() {
    await loadScheduledRuns();
    await processDueRuns();
  }

  async function tick() {
    tickPromise = tickPromise
      .catch(() => {})
      .then(runTick)
      .catch((err) => console.error('One-shot scheduler tick failed:', err))
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

  const initPromise = tick();

  return {
    stop,
    tick,
    ready: () => initPromise,
  };
}

module.exports = {
  startOneShotScheduler,
};

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const { installShutdownHooks } = require('../../src/app/lifecycle');

test('installShutdownHooks skips queue drain and cancels active runs in watch mode', async (t) => {
  t.afterEach(() => {
    mock.restoreAll();
  });

  const originalExecArgv = process.execArgv;
  Object.defineProperty(process, 'execArgv', {
    configurable: true,
    value: ['--watch'],
  });
  t.after(() => {
    Object.defineProperty(process, 'execArgv', {
      configurable: true,
      value: originalExecArgv,
    });
  });

  const exits = [];
  mock.method(process, 'exit', (code) => {
    exits.push(code);
  });

  let cancelledRuns = 0;
  let botStopSignal = null;
  const unresolvedQueue = new Promise(() => {});
  const shutdown = installShutdownHooks({
    bot: {
      stop: (signal) => {
        botStopSignal = signal;
      },
    },
    cancelActiveRuns: () => {
      cancelledRuns += 1;
    },
    getCronScheduler: () => null,
    getOneShotScheduler: () => null,
    getPersistPromises: () => [Promise.resolve()],
    getQueues: () => new Map([['chat:1', unresolvedQueue]]),
    shutdownDrainTimeoutMs: 10_000,
    stopHttpServer: async () => {},
  });

  shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(cancelledRuns, 1);
  assert.equal(botStopSignal, 'SIGTERM');
  assert.deepEqual(exits, [0]);
});

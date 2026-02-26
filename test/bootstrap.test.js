const assert = require('node:assert/strict');
const test = require('node:test');

const { bootstrapApp } = require('../src/app/bootstrap');

test('bootstrapApp launches bot with dropPendingUpdates enabled by default', () => {
  const calls = [];
  const infoCalls = [];
  const warnCalls = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args) => infoCalls.push(args.join(' '));
  console.warn = (...args) => warnCalls.push(args.join(' '));
  const bot = {
    launch: (options) => calls.push(options),
  };
  try {
    bootstrapApp({
      bot,
      initializeApp: () => {},
      installShutdownHooks: () => {},
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { dropPendingUpdates: true });
    assert.equal(infoCalls.some((line) => line.includes('dropPendingUpdates=true')), true);
    assert.equal(warnCalls.length, 0);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test('bootstrapApp respects AIPAL_DROP_PENDING_UPDATES=false', () => {
  const previous = process.env.AIPAL_DROP_PENDING_UPDATES;
  const calls = [];
  const infoCalls = [];
  const warnCalls = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args) => infoCalls.push(args.join(' '));
  console.warn = (...args) => warnCalls.push(args.join(' '));
  try {
    process.env.AIPAL_DROP_PENDING_UPDATES = 'false';
    const bot = {
      launch: (options) => calls.push(options),
    };
    bootstrapApp({
      bot,
      initializeApp: () => {},
      installShutdownHooks: () => {},
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { dropPendingUpdates: false });
    assert.equal(infoCalls.some((line) => line.includes('dropPendingUpdates=false')), true);
    assert.equal(
      warnCalls.some((line) => line.includes('AIPAL_DROP_PENDING_UPDATES=false')),
      true
    );
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.AIPAL_DROP_PENDING_UPDATES;
    else process.env.AIPAL_DROP_PENDING_UPDATES = previous;
  }
});

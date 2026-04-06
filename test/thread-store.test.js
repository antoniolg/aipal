const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeTopicId,
  buildTopicKey,
  buildThreadKey,
  normalizeContextKey,
  resolveThreadId,
  resolveThreadTopicId,
  clearThreadForAgent,
} = require('../src/thread-store');

test('normalizeTopicId', () => {
  assert.strictEqual(normalizeTopicId(undefined), 'root');
  assert.strictEqual(normalizeTopicId(null), 'root');
  assert.strictEqual(normalizeTopicId(''), 'root');
  assert.strictEqual(normalizeTopicId(123), '123');
  assert.strictEqual(normalizeTopicId('topic1'), 'topic1');
});

test('buildTopicKey', () => {
  assert.strictEqual(buildTopicKey(111, undefined), '111:root');
  assert.strictEqual(buildTopicKey(111, 222), '111:222');
});

test('buildThreadKey', () => {
  assert.strictEqual(buildThreadKey(111, 222, 'claude'), '111:222:claude');
  assert.strictEqual(
    buildThreadKey(111, 222, 'claude', 'cron:daily-content-curation'),
    '111:ctx:cron:daily-content-curation:claude'
  );
});

test('resolveThreadTopicId', () => {
  assert.strictEqual(resolveThreadTopicId(222), '222');
  assert.strictEqual(
    resolveThreadTopicId(222, 'cron:daily-content-curation'),
    'ctx:cron:daily-content-curation'
  );
  assert.strictEqual(normalizeContextKey(' cron:job '), 'ctx:cron:job');
});

test('resolveThreadId - direct hit', () => {
  const threads = new Map([['111:222:claude', 'session-abc']]);
  const result = resolveThreadId(threads, 111, 222, 'claude');
  assert.strictEqual(result.threadId, 'session-abc');
  assert.strictEqual(result.migrated, false);
});

test('resolveThreadId - migration from chatId:agentId', () => {
  const threads = new Map([['111:claude', 'session-abc']]);
  const result = resolveThreadId(threads, 111, undefined, 'claude');
  assert.strictEqual(result.threadId, 'session-abc');
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(threads.get('111:root:claude'), 'session-abc');
  assert.strictEqual(threads.has('111:claude'), false);
});

test('resolveThreadId - migration from chatId', () => {
  const threads = new Map([['111', 'session-abc']]);
  const result = resolveThreadId(threads, 111, undefined, 'claude');
  assert.strictEqual(result.threadId, 'session-abc');
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(threads.get('111:root:claude'), 'session-abc');
  assert.strictEqual(threads.has('111'), false);
});

test('resolveThreadId - no migration for non-root topics', () => {
  const threads = new Map([['111:claude', 'session-abc']]);
  const result = resolveThreadId(threads, 111, 'topic1', 'claude');
  assert.strictEqual(result.threadId, undefined);
  assert.strictEqual(result.migrated, false);
});

test('resolveThreadId - no migration for context threads', () => {
  const threads = new Map([['111:222:claude', 'session-abc']]);
  const result = resolveThreadId(
    threads,
    111,
    222,
    'claude',
    'cron:daily-content-curation'
  );
  assert.strictEqual(result.threadId, undefined);
  assert.strictEqual(result.threadKey, '111:ctx:cron:daily-content-curation:claude');
  assert.strictEqual(result.migrated, false);
});

test('clearThreadForAgent', () => {
  const threads = new Map([
    ['111:root:claude', 'abc'],
    ['111:claude', 'def'],
    ['111', 'ghi'],
    ['111:topic1:claude', 'jkl'],
  ]);

  // Clear non-root topic
  clearThreadForAgent(threads, 111, 'topic1', 'claude');
  assert.strictEqual(threads.has('111:topic1:claude'), false);
  assert.strictEqual(threads.has('111:root:claude'), true);

  // Clear root topic (should also clear legacy)
  clearThreadForAgent(threads, 111, undefined, 'claude');
  assert.strictEqual(threads.has('111:root:claude'), false);
  assert.strictEqual(threads.has('111:claude'), false);
  assert.strictEqual(threads.has('111'), false);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatCronAlert } = require('../../src/services/cron-alerts');

test('formatCronAlert renders dead-letter alerts', () => {
  const message = formatCronAlert({
    type: 'dead_letter',
    jobId: 'daily',
    run: {
      scheduledAt: '2026-03-10T10:00:00.000Z',
      attempt: 3,
      maxAttempts: 3,
      error: 'boom',
    },
  });

  assert.match(message, /daily/);
  assert.match(message, /DLQ/);
  assert.match(message, /3\/3/);
  assert.match(message, /boom/);
});

test('formatCronAlert renders missed-schedule alerts', () => {
  const message = formatCronAlert({
    type: 'missed_schedule',
    jobId: 'daily',
    count: 5,
    firstMissedAt: '2026-03-10T10:01:00.000Z',
    lastMissedAt: '2026-03-10T10:05:00.000Z',
    catchupWindowSeconds: 600,
  });

  assert.match(message, /missed 5 schedule slot/);
  assert.match(message, /10:01:00/);
  assert.match(message, /600s/);
});

test('formatCronAlert renders one-shot dead-letter alerts', () => {
  const message = formatCronAlert({
    type: 'scheduled_run_dead_letter',
    runId: 'once-1',
    run: {
      runAt: '2026-03-20T08:30:00.000Z',
      attempt: 2,
      maxAttempts: 2,
      lastError: 'boom',
    },
  });

  assert.match(message, /once-1/);
  assert.match(message, /DLQ/);
  assert.match(message, /2\/2/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCronInspection,
  formatCronInspection,
  formatRunsMessage,
  listRecentRuns,
} = require('../../src/services/cron-observability');

test('listRecentRuns returns newest attempts first and supports job filters', () => {
  const jobs = [
    { id: 'daily', enabled: true },
    { id: 'weekly', enabled: false },
  ];
  const cronState = {
    jobs: {
      daily: {
        recentRuns: [
          {
            scheduledAt: '2026-03-10T09:00:00.000Z',
            startedAt: '2026-03-10T09:00:00.000Z',
            finishedAt: '2026-03-10T09:00:02.000Z',
            attempt: 1,
            maxAttempts: 3,
            reason: 'scheduled',
            status: 'succeeded',
          },
        ],
      },
      weekly: {
        recentRuns: [
          {
            scheduledAt: '2026-03-10T10:00:00.000Z',
            startedAt: '2026-03-10T10:00:01.000Z',
            finishedAt: '2026-03-10T10:00:03.000Z',
            attempt: 2,
            maxAttempts: 3,
            reason: 'retry',
            status: 'retry_scheduled',
            error: 'boom',
          },
        ],
      },
    },
  };

  const allRuns = listRecentRuns({ jobs, cronState, limit: 10 });
  assert.equal(allRuns.length, 2);
  assert.equal(allRuns[0].jobId, 'weekly');
  assert.equal(allRuns[1].jobId, 'daily');

  const filtered = listRecentRuns({ jobs, cronState, limit: 10, jobId: 'daily' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].jobId, 'daily');
});

test('buildCronInspection summarizes lag, next runs, and recent attempts', () => {
  const inspection = buildCronInspection({
    job: {
      id: 'daily',
      enabled: true,
      cron: '0 9 * * *',
      timezone: 'UTC',
      chatId: 123,
      topicId: 456,
    },
    cronState: {
      jobs: {
        daily: {
          lastStatus: 'retry_scheduled',
          lastScheduledAt: '2026-03-10T09:00:00.000Z',
          lastStartedAt: '2026-03-10T09:00:00.000Z',
          lastFinishedAt: '2026-03-10T09:00:05.000Z',
          lastSuccessAt: '2026-03-09T09:00:03.000Z',
          lastFailedAt: '2026-03-10T09:00:05.000Z',
          lastError: 'boom',
          lastMissedAlertAt: '2026-03-10T08:59:00.000Z',
          pendingRuns: [
            {
              scheduledAt: '2026-03-10T09:00:00.000Z',
              runAfter: '2026-03-10T09:02:00.000Z',
              attempt: 2,
              reason: 'retry',
            },
          ],
          recentRuns: [
            {
              scheduledAt: '2026-03-10T09:00:00.000Z',
              startedAt: '2026-03-10T09:00:00.000Z',
              finishedAt: '2026-03-10T09:00:05.000Z',
              attempt: 1,
              maxAttempts: 3,
              reason: 'scheduled',
              status: 'retry_scheduled',
              error: 'boom',
            },
          ],
          deadLetterRuns: [
            {
              scheduledAt: '2026-03-09T09:00:00.000Z',
              startedAt: '2026-03-09T09:00:00.000Z',
              finishedAt: '2026-03-09T09:00:03.000Z',
              attempt: 3,
              maxAttempts: 3,
              reason: 'retry',
              status: 'dead_letter',
              error: 'older boom',
            },
          ],
        },
      },
    },
    now: () => new Date('2026-03-10T09:03:00.000Z'),
  });

  assert.equal(inspection.jobId, 'daily');
  assert.equal(inspection.pendingCount, 1);
  assert.equal(inspection.lagMs, 3 * 60 * 1000);
  assert.equal(inspection.deadLetterCount, 1);
  assert.deepEqual(inspection.nextRuns, [
    '2026-03-11T09:00:00.000Z',
    '2026-03-12T09:00:00.000Z',
    '2026-03-13T09:00:00.000Z',
  ]);
  assert.equal(inspection.recentRuns.length, 1);

  const message = formatCronInspection(inspection);
  assert.match(message, /Cron "daily"/);
  assert.match(message, /Lag: 3m/);
  assert.match(message, /DLQ runs: 1/);
  assert.match(message, /Recent attempts:/);
  assert.match(message, /Recent DLQ entries:/);
  assert.match(message, /error=boom/);
});

test('formatRunsMessage renders a readable summary', () => {
  const message = formatRunsMessage([
    {
      jobId: 'daily',
      scheduledAt: '2026-03-10T09:00:00.000Z',
      startedAt: '2026-03-10T09:00:00.000Z',
      attempt: 1,
      maxAttempts: 3,
      reason: 'scheduled',
      status: 'succeeded',
      error: null,
    },
  ]);

  assert.match(message, /Recent cron runs:/);
  assert.match(message, /daily/);
  assert.match(message, /attempt 1\/3/);
});

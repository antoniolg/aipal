const { createCronMatcher } = require('./cron-matcher');
const { createEmptyCronState, normalizeJobState, parseTimestamp } = require('./cron-state');

function getJobMap(jobs) {
  return new Map(jobs.map((job) => [job.id, job]));
}

function getRunTimestamp(run) {
  return (
    parseTimestamp(run.finishedAt)?.getTime()
    || parseTimestamp(run.startedAt)?.getTime()
    || parseTimestamp(run.runAfter)?.getTime()
    || parseTimestamp(run.scheduledAt)?.getTime()
    || 0
  );
}

function formatTimestamp(value) {
  if (!value) return '(never)';
  return String(value).replace('T', ' ').replace('.000Z', 'Z');
}

function formatLag(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function summarizeRun(run) {
  const parts = [
    `[${formatTimestamp(run.startedAt || run.finishedAt || run.scheduledAt)}]`,
    `${run.jobId}`,
    `${run.status}`,
    `attempt ${run.attempt}/${run.maxAttempts}`,
  ];
  if (run.reason) parts.push(`reason=${run.reason}`);
  if (run.error) parts.push(`error=${run.error}`);
  return parts.join(' | ');
}

function listRecentRuns({ jobs, cronState, limit = 10, jobId } = {}) {
  const state = cronState || createEmptyCronState();
  const jobMap = getJobMap(jobs || []);
  const runs = [];

  for (const [stateJobId, rawJobState] of Object.entries(state.jobs || {})) {
    if (jobId && stateJobId !== jobId) continue;
    const jobState = normalizeJobState(rawJobState);
    for (const run of jobState.recentRuns) {
      runs.push({
        ...run,
        jobId: stateJobId,
        enabled: jobMap.get(stateJobId)?.enabled ?? null,
      });
    }
  }

  return runs
    .sort((left, right) => getRunTimestamp(right) - getRunTimestamp(left))
    .slice(0, limit);
}

function computeLagMs(jobState, nowDate) {
  const dueRuns = [];
  if (jobState.runningRun) {
    dueRuns.push(jobState.runningRun);
  }
  for (const run of jobState.pendingRuns) {
    dueRuns.push(run);
  }

  const eligible = dueRuns
    .map((run) => parseTimestamp(run.scheduledAt)?.getTime())
    .filter((value) => Number.isFinite(value) && value <= nowDate.getTime());

  if (!eligible.length) return 0;
  return nowDate.getTime() - Math.min(...eligible);
}

function buildNextScheduledRuns(job, nowDate, count = 3) {
  if (!job?.cron) return [];
  const matcher = createCronMatcher(job.cron, job.timezone);
  const runs = [];
  let cursor = nowDate;
  while (runs.length < count) {
    const next = matcher.getNextMatch(cursor);
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
}

function buildCronInspection({ job, cronState, now = () => new Date() }) {
  if (!job) return null;
  const state = cronState || createEmptyCronState();
  const jobState = normalizeJobState(state.jobs?.[job.id]);
  const currentTime = now();
  const recentRuns = listRecentRuns({
    jobs: [job],
    cronState: { jobs: { [job.id]: jobState } },
    limit: 3,
    jobId: job.id,
  });

  return {
    jobId: job.id,
    enabled: !!job.enabled,
    cron: job.cron,
    timezone: job.timezone || 'Europe/Madrid',
    chatId: job.chatId ?? null,
    topicId: job.topicId ?? null,
    lastStatus: jobState.lastStatus || '(never)',
    lastScheduledAt: jobState.lastScheduledAt,
    lastStartedAt: jobState.lastStartedAt,
    lastFinishedAt: jobState.lastFinishedAt,
    lastSuccessAt: jobState.lastSuccessAt,
    lastFailedAt: jobState.lastFailedAt,
    lastError: jobState.lastError,
    lastMissedAlertAt: jobState.lastMissedAlertAt,
    running: !!jobState.runningRun,
    runningRun: jobState.runningRun,
    pendingCount: jobState.pendingRuns.length,
    pendingRuns: jobState.pendingRuns,
    deadLetterCount: jobState.deadLetterRuns.length,
    deadLetterRuns: jobState.deadLetterRuns.slice(-3).reverse(),
    lagMs: computeLagMs(jobState, currentTime),
    nextRuns: buildNextScheduledRuns(job, currentTime),
    recentRuns,
  };
}

function formatRunsMessage(runs) {
  if (!runs.length) return 'No cron runs recorded yet.';
  return ['Recent cron runs:', ...runs.map((run) => `- ${summarizeRun(run)}`)].join('\n');
}

function formatCronInspection(inspection) {
  if (!inspection) return 'Cron job not found.';
  const target = [
    inspection.chatId === null ? 'default chat' : `chat ${inspection.chatId}`,
    inspection.topicId === null ? null : `topic ${inspection.topicId}`,
  ]
    .filter(Boolean)
    .join(' / ');

  const lines = [
    `Cron "${inspection.jobId}"`,
    `Enabled: ${inspection.enabled ? 'yes' : 'no'}`,
    `Schedule: ${inspection.cron} (${inspection.timezone})`,
    `Target: ${target}`,
    `Last status: ${inspection.lastStatus}`,
    `Last scheduled slot: ${formatTimestamp(inspection.lastScheduledAt)}`,
    `Last started: ${formatTimestamp(inspection.lastStartedAt)}`,
    `Last finished: ${formatTimestamp(inspection.lastFinishedAt)}`,
    `Last success: ${formatTimestamp(inspection.lastSuccessAt)}`,
    `Last failure: ${formatTimestamp(inspection.lastFailedAt)}`,
    `Last missed alert: ${formatTimestamp(inspection.lastMissedAlertAt)}`,
    `Lag: ${formatLag(inspection.lagMs)}`,
    `Running now: ${inspection.running ? 'yes' : 'no'}`,
    `Pending runs: ${inspection.pendingCount}`,
    `DLQ runs: ${inspection.deadLetterCount}`,
  ];

  if (inspection.lastError) {
    lines.push(`Last error: ${inspection.lastError}`);
  }

  lines.push('Next runs:');
  for (const nextRun of inspection.nextRuns) {
    lines.push(`- ${formatTimestamp(nextRun)}`);
  }

  if (inspection.recentRuns.length) {
    lines.push('Recent attempts:');
    for (const run of inspection.recentRuns) {
      lines.push(`- ${summarizeRun(run)}`);
    }
  }

  if (inspection.deadLetterRuns.length) {
    lines.push('Recent DLQ entries:');
    for (const run of inspection.deadLetterRuns) {
      lines.push(`- ${summarizeRun(run)}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  buildCronInspection,
  formatCronInspection,
  formatRunsMessage,
  listRecentRuns,
};

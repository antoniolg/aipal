const { buildTelegramThreadExtra } = require('./telegram-topics');

function formatTimestamp(value) {
  if (!value) return '(unknown)';
  return String(value).replace('T', ' ').replace('.000Z', 'Z');
}

function formatCronAlert(event) {
  if (!event) return 'Cron alert.';

  if (event.type === 'dead_letter') {
    return [
      `Cron alert: "${event.jobId}" moved to DLQ.`,
      `Scheduled slot: ${formatTimestamp(event.run?.scheduledAt)}`,
      `Attempts: ${event.run?.attempt}/${event.run?.maxAttempts}`,
      `Last error: ${event.run?.error || '(unknown)'}`,
    ].join('\n');
  }

  if (event.type === 'missed_schedule') {
    return [
      `Cron alert: "${event.jobId}" missed ${event.count} schedule slot(s) outside the catch-up window.`,
      `Skipped range: ${formatTimestamp(event.firstMissedAt)} -> ${formatTimestamp(event.lastMissedAt)}`,
      `Catch-up window: ${event.catchupWindowSeconds}s`,
    ].join('\n');
  }

  if (event.type === 'scheduled_run_dead_letter') {
    return [
      `Scheduled run alert: "${event.runId}" moved to DLQ.`,
      `Scheduled for: ${formatTimestamp(event.run?.runAt)}`,
      `Attempts: ${event.run?.attempt}/${event.run?.maxAttempts}`,
      `Last error: ${event.run?.lastError || '(unknown)'}`,
    ].join('\n');
  }

  return `Cron alert: "${event.jobId}" (${event.type}).`;
}

function createCronAlertNotifier({ bot }) {
  return async function notifyCronAlert(event) {
    if (!event?.chatId) return;
    const extra = buildTelegramThreadExtra({
      topicId: event.topicId,
      forceTopic: true,
    });
    await bot.telegram.sendMessage(event.chatId, formatCronAlert(event), extra);
  };
}

module.exports = {
  createCronAlertNotifier,
  formatCronAlert,
};

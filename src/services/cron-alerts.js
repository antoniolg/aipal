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

  return `Cron alert: "${event.jobId}" (${event.type}).`;
}

function createCronAlertNotifier({ bot }) {
  return async function notifyCronAlert(event) {
    if (!event?.chatId) return;
    const extra = event.topicId ? { message_thread_id: event.topicId } : undefined;
    await bot.telegram.sendMessage(event.chatId, formatCronAlert(event), extra);
  };
}

module.exports = {
  createCronAlertNotifier,
  formatCronAlert,
};

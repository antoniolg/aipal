const DEFAULT_TIME_ZONE = 'Europe/Madrid';

function formatTimestampInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  const offsetParts = offsetFormatter.formatToParts(date);
  const offsetToken =
    offsetParts.find((part) => part.type === 'timeZoneName')?.value || 'GMT+00:00';
  const offset = offsetToken.replace(/^GMT/, '');
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

function buildTimestampPrefix(options = {}) {
  const date = options.date instanceof Date ? options.date : new Date();
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const formatted = formatTimestampInTimeZone(date, timeZone);
  return `[${formatted}]`;
}

function prefixTextWithTimestamp(text, options = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return raw;
  return `${buildTimestampPrefix(options)} ${raw.trimStart()}`;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  buildTimestampPrefix,
  prefixTextWithTimestamp,
};

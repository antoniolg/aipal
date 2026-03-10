const MONTH_ALIASES = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAY_ALIASES = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const FIELD_SPECS = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, aliases: MONTH_ALIASES },
  { name: 'weekday', min: 0, max: 7, aliases: WEEKDAY_ALIASES },
];

const FORMATTERS = new Map();

function normalizeCronExpression(expression) {
  const normalized = String(expression || '').trim().replace(/\s+/g, ' ');
  const fields = normalized.split(' ');
  if (fields.length === 5) return ['0', ...fields];
  if (fields.length === 6) return fields;
  throw new Error(`Unsupported cron expression: ${expression}`);
}

function parseCronValue(rawValue, spec) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (normalized in (spec.aliases || {})) {
    return spec.aliases[normalized];
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid cron field value "${rawValue}"`);
  }
  if (parsed < spec.min || parsed > spec.max) {
    throw new Error(`Cron field value out of range: "${rawValue}"`);
  }
  return spec.name === 'weekday' && parsed === 7 ? 0 : parsed;
}

function addCronSegmentValues(segment, spec, values) {
  const [base, stepRaw] = segment.split('/');
  if (!base || segment.split('/').length > 2) {
    throw new Error(`Invalid cron field segment "${segment}"`);
  }

  const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`Invalid cron field step "${segment}"`);
  }

  let rangeStart = spec.min;
  let rangeEnd = spec.max;
  if (base !== '*') {
    const [startRaw, endRaw] = base.split('-');
    if (!startRaw || base.split('-').length > 2) {
      throw new Error(`Invalid cron field range "${segment}"`);
    }
    rangeStart = parseCronValue(startRaw, spec);
    rangeEnd = endRaw === undefined ? rangeStart : parseCronValue(endRaw, spec);
    if (rangeStart > rangeEnd) {
      throw new Error(`Descending cron ranges are not supported: "${segment}"`);
    }
  }

  for (let value = rangeStart; value <= rangeEnd; value += step) {
    values.add(spec.name === 'weekday' && value === 7 ? 0 : value);
  }
}

function parseCronField(field, spec) {
  const normalizedField = String(field || '')
    .trim()
    .replace(/[A-Za-z]+/g, (token) => String(parseCronValue(token, spec)));
  const values = new Set();
  for (const segment of normalizedField.split(',')) {
    addCronSegmentValues(segment.trim(), spec, values);
  }
  return [...values].sort((left, right) => left - right);
}

function buildCronParts(expression) {
  const fields = normalizeCronExpression(expression);
  return fields.map((field, index) => parseCronField(field, FIELD_SPECS[index]));
}

function getFormatter(timezone) {
  const key = timezone || 'UTC';
  if (!FORMATTERS.has(key)) {
    FORMATTERS.set(
      key,
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    );
  }
  return FORMATTERS.get(key);
}

function getLocalizedDateParts(date, timezone) {
  const parts = getFormatter(timezone).formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    second: Number.parseInt(values.second, 10),
    minute: Number.parseInt(values.minute, 10),
    hour: values.hour === '24' ? 0 : Number.parseInt(values.hour, 10),
    day: Number.parseInt(values.day, 10),
    month: Number.parseInt(values.month, 10),
    weekday: WEEKDAY_ALIASES[String(values.weekday || '').toLowerCase()],
  };
}

function matchesCronParts(parts, date, timezone) {
  const localized = getLocalizedDateParts(date, timezone);
  return FIELD_SPECS.every((spec, index) => parts[index].includes(localized[spec.name]));
}

function createCronMatcher(expression, timezone) {
  const parts = buildCronParts(expression);
  const hasSeconds = normalizeCronExpression(expression).length === 6;
  const stepMs = hasSeconds ? 1000 : 60 * 1000;
  const maxLookaheadMs = 366 * 24 * 60 * 60 * 1000;

  return {
    match(date) {
      return matchesCronParts(parts, date, timezone);
    },
    getNextMatch(afterDate) {
      const afterMs = afterDate.getTime();
      let candidateMs = hasSeconds
        ? Math.floor(afterMs / 1000) * 1000 + 1000
        : Math.floor(afterMs / stepMs) * stepMs + stepMs;
      const deadline = afterMs + maxLookaheadMs;

      while (candidateMs <= deadline) {
        const candidate = new Date(candidateMs);
        if (matchesCronParts(parts, candidate, timezone)) {
          return candidate;
        }
        candidateMs += stepMs;
      }

      throw new Error(`Unable to find next cron slot for expression "${expression}"`);
    },
  };
}

module.exports = {
  createCronMatcher,
};

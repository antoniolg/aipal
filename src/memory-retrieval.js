const fs = require('node:fs/promises');
const path = require('node:path');

const { MEMORY_THREADS_DIR } = require('./memory-store');
const { normalizeTopicId } = require('./thread-store');

const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_SNIPPET_LENGTH = 220;
const DIVERSITY_SCOPE_ORDER = [
  'same-thread',
  'same-topic',
  'global',
  'same-chat',
];

const STOPWORDS = new Set([
  'a',
  'al',
  'algo',
  'and',
  'ante',
  'con',
  'como',
  'de',
  'del',
  'el',
  'en',
  'es',
  'esta',
  'este',
  'for',
  'from',
  'hay',
  'i',
  'la',
  'las',
  'lo',
  'los',
  'me',
  'mi',
  'my',
  'o',
  'para',
  'por',
  'que',
  'se',
  'si',
  'sin',
  'sobre',
  'su',
  'the',
  'to',
  'un',
  'una',
  'y',
  'yo',
]);

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function tokenize(input) {
  const cleaned = normalizeText(input).toLowerCase();
  if (!cleaned) return [];
  const raw = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const token of raw) {
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function parseJsonl(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === 'object') {
        events.push(event);
      }
    } catch {
      // Ignore malformed lines
    }
  }
  return events;
}

function toIsoDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function toDisplayTimestamp(value) {
  const date = new Date(toIsoDate(value));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function scoreScope(event, target) {
  const eventChat = String(event.chatId || '');
  const eventTopic = normalizeTopicId(event.topicId);
  const eventAgent = String(event.agentId || '');

  const targetChat = String(target.chatId || '');
  const targetTopic = normalizeTopicId(target.topicId);
  const targetAgent = String(target.agentId || '');

  if (eventChat === targetChat && eventTopic === targetTopic && eventAgent === targetAgent) {
    return { value: 6, label: 'same-thread' };
  }
  if (eventChat === targetChat && eventTopic === targetTopic) {
    return { value: 4, label: 'same-topic' };
  }
  if (eventChat === targetChat) {
    return { value: 2, label: 'same-chat' };
  }
  return { value: 0.5, label: 'global' };
}

function scoreLexical(text, queryTokens, queryText) {
  if (!queryTokens.length) return 0;
  const lower = String(text || '').toLowerCase();
  if (!lower) return 0;
  let matched = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) matched += 1;
  }
  let score = (matched / queryTokens.length) * 5;
  const queryPhrase = normalizeText(queryText).toLowerCase();
  if (queryPhrase && queryPhrase.length >= 8 && lower.includes(queryPhrase)) {
    score += 2;
  }
  return score;
}

function scoreRecency(createdAt, nowMs) {
  const ms = new Date(toIsoDate(createdAt)).getTime();
  const days = Math.max(0, (nowMs - ms) / (24 * 60 * 60 * 1000));
  return Math.exp(-days / 7) * 2;
}

function truncate(text, maxLength = DEFAULT_SNIPPET_LENGTH) {
  const clean = normalizeText(text);
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}…`;
}

async function readRecentThreadEvents(maxFiles = DEFAULT_MAX_FILES) {
  let entries = [];
  try {
    entries = await fs.readdir(MEMORY_THREADS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(MEMORY_THREADS_DIR, entry.name));

  const withStats = await Promise.all(
    files.map(async (filePath) => {
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = withStats.slice(0, Math.max(1, maxFiles));
  const all = [];
  for (const item of selected) {
    const raw = await fs.readFile(item.filePath, 'utf8');
    for (const event of parseJsonl(raw)) {
      const text = truncate(event.text, 1000);
      if (!text) continue;
      all.push({
        ...event,
        createdAt: toIsoDate(event.createdAt),
        text,
      });
    }
  }
  return all;
}

async function searchMemory(options = {}) {
  const query = String(options.query || '');
  const queryTokens = tokenize(query);
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(30, Math.trunc(options.limit)))
    : DEFAULT_LIMIT;
  const maxFiles = Number.isFinite(options.maxFiles)
    ? Math.max(1, Math.trunc(options.maxFiles))
    : DEFAULT_MAX_FILES;

  const all = await readRecentThreadEvents(maxFiles);
  if (!all.length) return [];

  const nowMs = Date.now();
  const scored = [];
  for (const event of all) {
    const scope = scoreScope(event, options);
    const lexical = scoreLexical(event.text, queryTokens, query);
    if (queryTokens.length > 0 && lexical === 0 && scope.value < 4) continue;
    const recency = scoreRecency(event.createdAt, nowMs);
    const roleBoost = event.role === 'user' ? 0.3 : 0;
    const score = scope.value + lexical + recency + roleBoost;
    scored.push({
      ...event,
      scope: scope.label,
      score,
    });
  }

  scored.sort(
    (a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)
  );

  const uniqueByText = [];
  const seen = new Set();
  for (const event of scored) {
    const key = normalizeText(event.text).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueByText.push(event);
  }

  return selectDiversifiedResults(uniqueByText, limit);
}

function selectDiversifiedResults(events, limit) {
  if (!Array.isArray(events) || events.length === 0 || limit <= 0) return [];

  const byScope = new Map();
  for (const scope of DIVERSITY_SCOPE_ORDER) {
    byScope.set(scope, []);
  }

  for (const event of events) {
    const scope = byScope.has(event.scope) ? event.scope : 'global';
    byScope.get(scope).push(event);
  }

  const selected = [];
  const selectedIds = new Set();

  for (const scope of DIVERSITY_SCOPE_ORDER) {
    if (selected.length >= limit) break;
    const candidates = byScope.get(scope) || [];
    if (!candidates.length) continue;
    const event = candidates.shift();
    const eventIdentity = getEventIdentity(event);
    if (!event || selectedIds.has(eventIdentity)) continue;
    selected.push(event);
    selectedIds.add(eventIdentity);
  }

  for (const event of events) {
    if (selected.length >= limit) break;
    const eventIdentity = getEventIdentity(event);
    if (selectedIds.has(eventIdentity)) continue;
    selected.push(event);
    selectedIds.add(eventIdentity);
  }

  return selected;
}

function getEventIdentity(event) {
  if (event?.id) return String(event.id);
  const createdAt = toIsoDate(event?.createdAt);
  const chatId = String(event?.chatId || '');
  const topicId = normalizeTopicId(event?.topicId);
  const role = String(event?.role || '');
  const text = normalizeText(event?.text || '');
  return `${createdAt}|${chatId}|${topicId}|${role}|${text}`;
}

async function buildMemoryRetrievalContext(options = {}) {
  const hits = await searchMemory(options);
  if (!hits.length) return '';
  const lines = ['Relevant memory retrieved:'];
  for (const hit of hits) {
    const who = hit.role === 'assistant' ? 'assistant' : 'user';
    lines.push(
      `- [${toDisplayTimestamp(hit.createdAt)}] (${hit.scope}, ${who}) ${truncate(
        hit.text
      )}`
    );
  }
  return lines.join('\n');
}

module.exports = {
  buildMemoryRetrievalContext,
  searchMemory,
};

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 500;
const SESSION_ID_REGEX = /^[0-9a-f][0-9a-f-]{15,}$/i;

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeCwd(value) {
  if (!value) return '';
  try {
    return path.resolve(String(value));
  } catch {
    return '';
  }
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

async function readHead(filePath, size = 24 * 1024) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(filePath, size = 64 * 1024) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - size);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function extractMetaFromHead(filePath, head, fallbackTimestamp) {
  const idMatch = head.match(/"type":"session_meta".*?"id":"([^"]+)"/s);
  const fileIdMatch = filePath.match(/([0-9a-f]{8,}-[0-9a-f-]{10,})\.jsonl$/i);
  const id = (idMatch && idMatch[1]) || (fileIdMatch && fileIdMatch[1]) || '';
  if (!SESSION_ID_REGEX.test(id)) return null;

  const timestampMatch = head.match(
    /"type":"session_meta","payload":\{"id":"[^"]+","timestamp":"([^"]+)"/
  );
  const cwdMatch = head.match(/"type":"session_meta".*?"cwd":"((?:\\.|[^"\\])*)"/s);
  const cwd = cwdMatch ? decodeJsonString(cwdMatch[1]) : '';
  const displayName = extractSessionDisplayNameFromHead(head);

  return {
    id,
    timestamp: (timestampMatch && timestampMatch[1]) || fallbackTimestamp,
    cwd,
    displayName,
    filePath,
  };
}

async function collectSessionFiles(rootDir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(fullPath);
    }
  }
  return out;
}

function byNewestPath(a, b) {
  return b.localeCompare(a);
}

function cwdMatches(sessionCwd, targetCwd) {
  if (!targetCwd) return true;
  const normalizedSession = normalizeCwd(sessionCwd);
  if (!normalizedSession) return false;
  return (
    normalizedSession === targetCwd ||
    normalizedSession.startsWith(`${targetCwd}${path.sep}`)
  );
}

function extractTextFromContent(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextFromContent(item))
      .filter(Boolean);
    return parts.join(' ').trim();
  }
  if (typeof value !== 'object') return '';

  if (typeof value.text === 'string' && value.text.trim()) {
    return value.text.trim();
  }
  if (typeof value.output_text === 'string' && value.output_text.trim()) {
    return value.output_text.trim();
  }
  if (value.content) {
    const nested = extractTextFromContent(value.content);
    if (nested) return nested;
  }
  return '';
}

function extractEntryMessageText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const type = String(entry.type || '').toLowerCase();
  if (type === 'session_meta') return '';

  const candidates = [entry.item, entry.payload, entry.data, entry];
  for (const candidate of candidates) {
    const text = extractTextFromContent(candidate);
    if (text) return text;
  }
  return '';
}

function extractSessionDisplayNameFromHead(headContent) {
  const lines = String(headContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    try {
      const entry = JSON.parse(lines[i]);
      const text = extractEntryMessageText(entry);
      if (!text) continue;
      const compact = text.replace(/\s+/g, ' ').trim();
      if (!compact) continue;
      if (compact.length <= 96) return compact;
      return `${compact.slice(0, 93)}...`;
    } catch {
      // Ignore malformed line.
    }
  }
  return '';
}

function extractLastSessionMessageFromTail(tailContent) {
  const lines = String(tailContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      const text = extractEntryMessageText(entry);
      if (text) return text;
    } catch {
      // Ignore malformed line.
    }
  }
  return '';
}

async function listLocalCodexSessions(options = {}) {
  const sessionsDir = options.sessionsDir || DEFAULT_SESSIONS_DIR;
  const limit = normalizeLimit(options.limit);
  const targetCwd = normalizeCwd(options.cwd);
  const files = await collectSessionFiles(sessionsDir);
  files.sort(byNewestPath);

  const sessions = [];
  for (const filePath of files) {
    if (sessions.length >= limit) break;
    try {
      const stat = await fs.stat(filePath);
      const fallbackTimestamp = stat.mtime.toISOString();
      const head = await readHead(filePath);
      const meta = extractMetaFromHead(filePath, head, fallbackTimestamp);
      if (!meta) continue;
      if (!cwdMatches(meta.cwd, targetCwd)) continue;
      sessions.push(meta);
    } catch {
      // Ignore malformed/rotated files.
    }
  }
  return sessions;
}

function isValidSessionId(value) {
  if (!value) return false;
  return SESSION_ID_REGEX.test(String(value).trim());
}

async function getLocalCodexSessionLastMessage(sessionId, options = {}) {
  const id = String(sessionId || '').trim();
  if (!isValidSessionId(id)) return '';
  const sessionsDir = options.sessionsDir || DEFAULT_SESSIONS_DIR;

  let filePath = '';
  if (typeof options.filePath === 'string' && options.filePath.trim()) {
    filePath = options.filePath.trim();
  } else {
    const sessions = await listLocalCodexSessions({
      sessionsDir,
      limit: MAX_LIMIT,
    });
    const found = sessions.find((session) => session.id === id);
    filePath = found?.filePath || '';
  }
  if (!filePath) return '';

  try {
    const tail = await readTail(filePath);
    return extractLastSessionMessageFromTail(tail);
  } catch {
    return '';
  }
}

module.exports = {
  DEFAULT_SESSIONS_DIR,
  getLocalCodexSessionLastMessage,
  isValidSessionId,
  listLocalCodexSessions,
};

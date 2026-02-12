const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CONFIG_DIR } = require('./config-store');

const MEMORY_DIR = path.join(CONFIG_DIR, 'memory');
const MEMORY_THREADS_DIR = path.join(MEMORY_DIR, 'threads');
const MEMORY_INDEX_PATH = path.join(MEMORY_DIR, 'index.sqlite');

const DEFAULT_INDEX_SYNC_INTERVAL_MS = 5000;
const DEFAULT_QUERY_LIMIT = 80;
const MAX_EVENT_TEXT_LENGTH = 2000;

let db;
let dbReady;
let dbSupportsFts = true;
let operationQueue = Promise.resolve();
let lastSyncMs = 0;

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function truncateText(input, maxLength = MAX_EVENT_TEXT_LENGTH) {
  const text = normalizeText(input);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function safeIsoDate(value) {
  try {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function tokenizeForLike(queryTokens, query) {
  const directTokens = Array.isArray(queryTokens)
    ? queryTokens.map((token) => normalizeText(token).toLowerCase()).filter(Boolean)
    : [];
  if (directTokens.length > 0) return directTokens;
  return normalizeText(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function stableEventId(event, fallback = '') {
  if (event?.id) return String(event.id);
  const source = `${safeIsoDate(event?.createdAt)}|${String(event?.threadKey || '')}|${String(
    event?.chatId || ''
  )}|${String(event?.topicId || '')}|${String(event?.agentId || '')}|${String(
    event?.role || ''
  )}|${String(event?.text || '')}|${fallback}`;
  return createHash('sha1').update(source).digest('hex');
}

function toIndexedEvent(event, fallback = '') {
  return {
    id: stableEventId(event, fallback || randomUUID()),
    createdAt: safeIsoDate(event?.createdAt),
    threadKey: String(event?.threadKey || ''),
    chatId: String(event?.chatId || ''),
    topicId: event?.topicId == null ? '' : String(event.topicId),
    agentId: String(event?.agentId || ''),
    role: event?.role === 'assistant' ? 'assistant' : 'user',
    kind: String(event?.kind || 'text'),
    text: truncateText(event?.text),
  };
}

function parseJsonl(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') {
        events.push({ event, lineNumber: i + 1 });
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return events;
}

function buildFtsQuery(queryTokens, query) {
  const tokens = tokenizeForLike(queryTokens, query)
    .map((token) => token.replace(/"/g, ''))
    .filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map((token) => `"${token}"*`).join(' OR ');
}

async function withIndexLock(task) {
  operationQueue = operationQueue.catch(() => {}).then(task);
  return operationQueue;
}

async function ensureIndexReady() {
  if (db) return db;
  if (!dbReady) {
    dbReady = (async () => {
      await fs.mkdir(MEMORY_DIR, { recursive: true });
      db = new DatabaseSync(MEMORY_INDEX_PATH);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          topic_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_chat_topic ON events(chat_id, topic_id);');
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_files (
          file_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          synced_at TEXT NOT NULL
        );
      `);
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
          USING fts5(
            text,
            content='events',
            content_rowid='rowid',
            tokenize='unicode61'
          );
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
            INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
          END;
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          END;
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
          END;
        `);
      } catch {
        dbSupportsFts = false;
      }
      if (dbSupportsFts) {
        db.exec(`INSERT INTO events_fts(events_fts) VALUES ('rebuild');`);
      }
      return db;
    })();
  }
  return dbReady;
}

function insertEventSync(event) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      id,
      created_at,
      thread_key,
      chat_id,
      topic_id,
      agent_id,
      role,
      kind,
      text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
  `);
  stmt.run(
    event.id,
    event.createdAt,
    event.threadKey,
    event.chatId,
    event.topicId,
    event.agentId,
    event.role,
    event.kind,
    event.text
  );
}

async function listThreadFilesWithStats() {
  let entries = [];
  try {
    entries = await fs.readdir(MEMORY_THREADS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(MEMORY_THREADS_DIR, entry.name);
    const stat = await fs.stat(filePath);
    files.push({
      filePath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sizeBytes: stat.size,
    });
  }
  return files;
}

async function syncMemoryIndexUnlocked(options = {}) {
  await ensureIndexReady();
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, Math.trunc(options.minIntervalMs))
    : DEFAULT_INDEX_SYNC_INTERVAL_MS;
  const now = Date.now();
  if (!options.force && now - lastSyncMs < minIntervalMs) {
    return { syncedFiles: 0, insertedEvents: 0 };
  }
  const files = await listThreadFilesWithStats();
  if (!files.length) {
    lastSyncMs = now;
    return { syncedFiles: 0, insertedEvents: 0 };
  }
  const selectFile = db.prepare(
    'SELECT mtime_ms AS mtimeMs, size_bytes AS sizeBytes FROM source_files WHERE file_path = ?;'
  );
  const upsertFile = db.prepare(`
    INSERT INTO source_files (file_path, mtime_ms, size_bytes, synced_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      synced_at = excluded.synced_at;
  `);
  let syncedFiles = 0;
  let insertedEvents = 0;
  for (const file of files) {
    const known = selectFile.get(file.filePath);
    if (
      known &&
      Number(known.mtimeMs) === file.mtimeMs &&
      Number(known.sizeBytes) === file.sizeBytes
    ) {
      continue;
    }
    const raw = await fs.readFile(file.filePath, 'utf8');
    const parsedEvents = parseJsonl(raw);
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const { event, lineNumber } of parsedEvents) {
        const indexed = toIndexedEvent(
          event,
          `${file.filePath}:${lineNumber}:${randomUUID()}`
        );
        if (!indexed.text) continue;
        const before = db.prepare('SELECT 1 AS present FROM events WHERE id = ?;').get(indexed.id);
        insertEventSync(indexed);
        if (!before) insertedEvents += 1;
      }
      upsertFile.run(file.filePath, file.mtimeMs, file.sizeBytes, safeIsoDate());
      db.exec('COMMIT;');
      syncedFiles += 1;
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }
  lastSyncMs = now;
  return { syncedFiles, insertedEvents };
}

async function syncMemoryIndex(options = {}) {
  return withIndexLock(async () => syncMemoryIndexUnlocked(options));
}

async function indexMemoryEvent(event) {
  return withIndexLock(async () => {
    await ensureIndexReady();
    const indexed = toIndexedEvent(event, randomUUID());
    if (!indexed.text) return { inserted: false };
    insertEventSync(indexed);
    return { inserted: true };
  });
}

function mapRow(row) {
  return {
    id: String(row.id || ''),
    createdAt: safeIsoDate(row.createdAt),
    threadKey: String(row.threadKey || ''),
    chatId: String(row.chatId || ''),
    topicId: String(row.topicId || ''),
    agentId: String(row.agentId || ''),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    kind: String(row.kind || 'text'),
    text: String(row.text || ''),
  };
}

async function queryIndexedEvents(options = {}) {
  return withIndexLock(async () => {
    await ensureIndexReady();
    await syncMemoryIndexUnlocked({ minIntervalMs: options.minSyncIntervalMs });

    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(300, Math.trunc(options.limit)))
      : DEFAULT_QUERY_LIMIT;
    const queryTokens = Array.isArray(options.queryTokens) ? options.queryTokens : [];
    const query = String(options.query || '');

    if (!queryTokens.length && !query.trim()) {
      const rows = db
        .prepare(`
          SELECT
            id,
            created_at AS createdAt,
            thread_key AS threadKey,
            chat_id AS chatId,
            topic_id AS topicId,
            agent_id AS agentId,
            role,
            kind,
            text
          FROM events
          ORDER BY created_at DESC
          LIMIT ?;
        `)
        .all(limit);
      return rows.map(mapRow);
    }

    if (dbSupportsFts) {
      const ftsQuery = buildFtsQuery(queryTokens, query);
      if (ftsQuery) {
        const rows = db
          .prepare(`
            SELECT
              e.id,
              e.created_at AS createdAt,
              e.thread_key AS threadKey,
              e.chat_id AS chatId,
              e.topic_id AS topicId,
              e.agent_id AS agentId,
              e.role,
              e.kind,
              e.text
            FROM events_fts f
            JOIN events e ON e.rowid = f.rowid
            WHERE f.text MATCH ?
            ORDER BY bm25(events_fts), e.created_at DESC
            LIMIT ?;
          `)
          .all(ftsQuery, limit);
        return rows.map(mapRow);
      }
    }

    const likeTokens = tokenizeForLike(queryTokens, query).slice(0, 6);
    if (!likeTokens.length) return [];
    const whereClause = likeTokens.map(() => 'LOWER(text) LIKE ?').join(' OR ');
    const params = likeTokens.map((token) => `%${token.toLowerCase()}%`);
    const rows = db
      .prepare(`
        SELECT
          id,
          created_at AS createdAt,
          thread_key AS threadKey,
          chat_id AS chatId,
          topic_id AS topicId,
          agent_id AS agentId,
          role,
          kind,
          text
        FROM events
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ?;
      `)
      .all(...params, limit);
    return rows.map(mapRow);
  });
}

async function getMemoryIndexStatus() {
  return withIndexLock(async () => {
    await ensureIndexReady();
    const result = db.prepare('SELECT COUNT(*) AS totalEvents FROM events;').get();
    const totalEvents = Number(result?.totalEvents || 0);
    return {
      indexPath: MEMORY_INDEX_PATH,
      totalEvents,
      supportsFts: dbSupportsFts,
    };
  });
}

module.exports = {
  MEMORY_INDEX_PATH,
  getMemoryIndexStatus,
  indexMemoryEvent,
  queryIndexedEvents,
  syncMemoryIndex,
};

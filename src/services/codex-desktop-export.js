const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const RETRY_DELAY_MS = 150;
const RETRY_ATTEMPTS = 10;

function createError(message, details = {}) {
  const err = new Error(message);
  Object.assign(err, details);
  return err;
}

function uniquePaths(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function readPathLabelMap(state) {
  const labels = state?.['electron-workspace-root-labels'];
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    return {};
  }
  return labels;
}

async function walkForRollout(dirPath, threadId) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkForRollout(fullPath, threadId);
      if (nested) return nested;
      continue;
    }
    if (
      entry.isFile()
      && entry.name.endsWith(`${threadId}.jsonl`)
      && entry.name.startsWith('rollout-')
    ) {
      return fullPath;
    }
  }
  return null;
}

function buildBackupPath(rolloutPath) {
  return `${rolloutPath}.bak-send-to-codex-${Date.now()}`;
}

function sortProjects(projects) {
  return [...projects].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

function createCodexDesktopExportService(options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const globalStatePath = options.globalStatePath || path.join(codexHome, '.codex-global-state.json');
  const sessionsRoot = options.sessionsRoot || path.join(codexHome, 'sessions');
  const logger = options.logger || console;

  async function readGlobalState() {
    const raw = await fs.readFile(globalStatePath, 'utf8');
    return JSON.parse(raw);
  }

  async function listProjects() {
    const state = await readGlobalState();
    const saved = uniquePaths(state?.['electron-saved-workspace-roots'] || []);
    const activeSet = new Set(uniquePaths(state?.['active-workspace-roots'] || []));
    const labels = readPathLabelMap(state);
    return sortProjects(
      saved.map((projectPath) => ({
        active: activeSet.has(projectPath),
        label: String(labels[projectPath] || '').trim() || path.basename(projectPath) || projectPath,
        path: projectPath,
      }))
    );
  }

  async function findRolloutPathByThreadId(threadId) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId) {
      throw createError('threadId is required to locate a rollout');
    }

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      const hit = await walkForRollout(sessionsRoot, normalizedThreadId);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    throw createError(`Could not find rollout for thread ${normalizedThreadId}`, {
      threadId: normalizedThreadId,
    });
  }

  async function promoteForkedThread({ projectPath, threadId }) {
    const rolloutPath = await findRolloutPathByThreadId(threadId);
    const original = await fs.readFile(rolloutPath, 'utf8');
    const lines = original.split('\n');
    if (lines.length === 0 || !lines[0].trim()) {
      throw createError(`Rollout ${rolloutPath} is empty`, { rolloutPath, threadId });
    }

    let firstEntry;
    try {
      firstEntry = JSON.parse(lines[0]);
    } catch (err) {
      throw createError(`Invalid session_meta in ${rolloutPath}`, {
        cause: err,
        rolloutPath,
        threadId,
      });
    }

    if (firstEntry?.type !== 'session_meta' || !firstEntry.payload) {
      throw createError(`Missing session_meta payload in ${rolloutPath}`, {
        rolloutPath,
        threadId,
      });
    }

    const backupPath = buildBackupPath(rolloutPath);
    await fs.writeFile(backupPath, original, 'utf8');

    firstEntry.payload.cwd = String(projectPath);
    firstEntry.payload.originator = 'Codex Desktop';
    firstEntry.payload.source = 'vscode';
    lines[0] = JSON.stringify(firstEntry);
    await fs.writeFile(rolloutPath, lines.join('\n'), 'utf8');
    logger.info?.(
      `Promoted forked rollout ${threadId} to Codex Desktop project=${projectPath}`
    );

    return {
      backupPath,
      rolloutPath,
      threadId: String(threadId),
    };
  }

  return {
    findRolloutPathByThreadId,
    listProjects,
    promoteForkedThread,
  };
}

module.exports = {
  createCodexDesktopExportService,
};

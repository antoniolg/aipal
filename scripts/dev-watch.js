#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_ENTRYPOINT = path.join('src', 'index.js');
const DEFAULT_WATCH_DIRS = ['src'];
const RESTART_DEBOUNCE_MS = 150;

function resolveNodeCommand(env = process.env) {
  return String(env.AIPAL_DEV_NODE || 'node').trim() || 'node';
}

function shouldRestart(fileName) {
  if (!fileName) return true;
  const text = String(fileName);
  return text.endsWith('.js') || text.endsWith('.json') || text.endsWith('.md');
}

function watchDirectoryRecursive(dirPath, onChange) {
  const watchers = [];

  function addWatcher(targetPath, recursive) {
    const watcher = fs.watch(targetPath, { recursive }, (_eventType, fileName) => {
      if (shouldRestart(fileName)) onChange(fileName || targetPath);
    });
    watcher.on('error', (err) => {
      console.warn(`Watcher error for ${targetPath}: ${err.message}`);
    });
    watchers.push(watcher);
  }

  try {
    addWatcher(dirPath, true);
  } catch (err) {
    if (err.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        watchers.push(...watchDirectoryRecursive(fullPath, onChange));
      }
    }
    addWatcher(dirPath, false);
  }

  return watchers;
}

function startDevWatch(options = {}) {
  const cwd = options.cwd || process.cwd();
  const entrypoint = options.entrypoint || DEFAULT_ENTRYPOINT;
  const nodeCommand = options.nodeCommand || resolveNodeCommand(options.env);
  const spawnProcess = options.spawnProcess || spawn;
  const watchDirs = options.watchDirs || DEFAULT_WATCH_DIRS;
  const logger = options.logger || console;

  let child = null;
  let restartTimer = null;
  let shuttingDown = false;
  let restartPending = false;

  function spawnChild() {
    if (shuttingDown) return;
    logger.info(`Starting ${entrypoint}`);
    child = spawnProcess(nodeCommand, [entrypoint], {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      logger.error(`Failed to spawn ${nodeCommand}: ${err.message}`);
      child = null;
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (shuttingDown) return;
      if (restartPending) {
        restartPending = false;
        spawnChild();
        return;
      }
      if (code !== 0 && signal !== 'SIGTERM') {
        logger.warn(`${entrypoint} exited with ${signal || `code ${code}`}. Waiting for changes...`);
      }
    });
  }

  function restart(reason) {
    if (shuttingDown) return;
    logger.info(`Restarting ${entrypoint}${reason ? ` (${reason})` : ''}`);
    if (child) {
      restartPending = true;
      child.kill('SIGTERM');
      return;
    }
    spawnChild();
  }

  function scheduleRestart(reason) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => restart(reason), RESTART_DEBOUNCE_MS);
  }

  const watchers = watchDirs.flatMap((dir) => {
    const fullPath = path.resolve(cwd, dir);
    if (!fs.existsSync(fullPath)) return [];
    return watchDirectoryRecursive(fullPath, (fileName) => scheduleRestart(String(fileName || dir)));
  });

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    if (child) child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  spawnChild();
  return { shutdown };
}

if (require.main === module) {
  startDevWatch();
}

module.exports = {
  resolveNodeCommand,
  shouldRestart,
  startDevWatch,
};

const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const CONFIG_PATH = path.join(XDG_CONFIG_HOME, 'aipal', 'config.json');
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const MEMORY_PATH = path.join(CONFIG_DIR, 'memory.md');
const SOUL_PATH = path.join(CONFIG_DIR, 'soul.md');
const TOOLS_PATH = path.join(CONFIG_DIR, 'tools.md');
const THREADS_PATH = path.join(CONFIG_DIR, 'threads.json');
const AGENT_OVERRIDES_PATH = path.join(CONFIG_DIR, 'agent-overrides.json');
const PROJECT_OVERRIDES_PATH = path.join(CONFIG_DIR, 'project-overrides.json');

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    console.warn('Failed to load config JSON:', err);
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  await fs.rename(tmpPath, CONFIG_PATH);
}

async function readMemory() {
  try {
    const raw = await fs.readFile(MEMORY_PATH, 'utf8');
    return { path: MEMORY_PATH, content: raw.trim(), exists: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { path: MEMORY_PATH, content: '', exists: false };
    }
    console.warn('Failed to load memory.md:', err);
    return { path: MEMORY_PATH, content: '', exists: false };
  }
}

async function readSoul() {
  try {
    const raw = await fs.readFile(SOUL_PATH, 'utf8');
    return { path: SOUL_PATH, content: raw.trim(), exists: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { path: SOUL_PATH, content: '', exists: false };
    }
    console.warn('Failed to load soul.md:', err);
    return { path: SOUL_PATH, content: '', exists: false };
  }
}

async function readTools() {
  try {
    const raw = await fs.readFile(TOOLS_PATH, 'utf8');
    return { path: TOOLS_PATH, content: raw.trim(), exists: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { path: TOOLS_PATH, content: '', exists: false };
    }
    console.warn('Failed to load tools.md:', err);
    return { path: TOOLS_PATH, content: '', exists: false };
  }
}

async function updateConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}

async function loadThreads() {
  try {
    const raw = await fs.readFile(THREADS_PATH, 'utf8');
    if (!raw.trim()) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    console.warn('Failed to load threads.json:', err);
    return new Map();
  }
}

async function saveThreads(threads) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const obj = Object.fromEntries(threads);
  const tmpPath = `${THREADS_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2));
  await fs.rename(tmpPath, THREADS_PATH);
}

async function loadJsonMap(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    console.warn(`Failed to load ${label}:`, err);
    return new Map();
  }
}

async function saveJsonMap(filePath, overrides) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const obj = Object.fromEntries(overrides);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2));
  await fs.rename(tmpPath, filePath);
}

async function loadAgentOverrides() {
  return loadJsonMap(AGENT_OVERRIDES_PATH, 'agent-overrides.json');
}

async function saveAgentOverrides(overrides) {
  return saveJsonMap(AGENT_OVERRIDES_PATH, overrides);
}

async function loadProjectOverrides() {
  return loadJsonMap(PROJECT_OVERRIDES_PATH, 'project-overrides.json');
}

async function saveProjectOverrides(overrides) {
  return saveJsonMap(PROJECT_OVERRIDES_PATH, overrides);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  MEMORY_PATH,
  SOUL_PATH,
  TOOLS_PATH,
  THREADS_PATH,
  AGENT_OVERRIDES_PATH,
  PROJECT_OVERRIDES_PATH,
  loadThreads,
  loadAgentOverrides,
  loadProjectOverrides,
  readConfig,
  readMemory,
  readSoul,
  readTools,
  saveThreads,
  saveAgentOverrides,
  saveProjectOverrides,
  updateConfig,
};

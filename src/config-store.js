const path = require('path');
const fs = require('fs/promises');

const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(process.cwd(), 'config.json');

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
  const dir = path.dirname(CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  await fs.rename(tmpPath, CONFIG_PATH);
}

async function updateConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}

module.exports = {
  CONFIG_PATH,
  readConfig,
  updateConfig,
};

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadConfigStore(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const modulePath = path.join(__dirname, '..', 'src', 'config-store.js');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('readConfig returns empty object when file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { readConfig } = loadConfigStore(dir);
  const config = await readConfig();
  assert.deepEqual(config, {});
});

test('updateConfig writes and merges config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { updateConfig, readConfig } = loadConfigStore(dir);
  await updateConfig({ model: 'gpt-5.2' });
  await updateConfig({ thinking: 'medium' });
  const config = await readConfig();
  assert.deepEqual(config, { model: 'gpt-5.2', thinking: 'medium' });
});

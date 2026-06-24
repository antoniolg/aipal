const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadEnvWith(value) {
  const modulePath = require.resolve('../../src/app/env');
  delete require.cache[modulePath];
  const previous = process.env.AIPAL_DEFAULT_PROJECT_DIR;
  if (value === undefined) {
    delete process.env.AIPAL_DEFAULT_PROJECT_DIR;
  } else {
    process.env.AIPAL_DEFAULT_PROJECT_DIR = value;
  }
  const loaded = require('../../src/app/env');
  delete require.cache[modulePath];
  if (previous === undefined) {
    delete process.env.AIPAL_DEFAULT_PROJECT_DIR;
  } else {
    process.env.AIPAL_DEFAULT_PROJECT_DIR = previous;
  }
  return loaded;
}

test('DEFAULT_PROJECT_DIR falls back to ~/.aipal', () => {
  const env = loadEnvWith(undefined);
  assert.equal(env.DEFAULT_PROJECT_DIR, path.join(os.homedir(), '.aipal'));
});

test('DEFAULT_PROJECT_DIR expands a configured home path', () => {
  const env = loadEnvWith('~/telegram-default');
  assert.equal(env.DEFAULT_PROJECT_DIR, path.join(os.homedir(), 'telegram-default'));
});

test('ensureDefaultProjectDir creates the configured directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-default-project-'));
  const nested = path.join(dir, 'nested', 'project');
  const env = loadEnvWith(nested);

  assert.equal(env.ensureDefaultProjectDir(), nested);
  const stat = await fs.stat(nested);
  assert.equal(stat.isDirectory(), true);
});

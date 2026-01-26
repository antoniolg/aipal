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
  await updateConfig({ agent: 'codex' });
  await updateConfig({ foo: 'bar' });
  const config = await readConfig();
  assert.deepEqual(config, { agent: 'codex', foo: 'bar' });
});

test('readMemory returns missing state when memory file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { readMemory } = loadConfigStore(dir);
  const memory = await readMemory();
  assert.equal(memory.exists, false);
  assert.equal(memory.content, '');
  assert.match(memory.path, /memory\.md$/);
});

test('readMemory loads memory content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { readMemory, MEMORY_PATH } = loadConfigStore(dir);
  await fs.mkdir(path.dirname(MEMORY_PATH), { recursive: true });
  await fs.writeFile(MEMORY_PATH, 'hello memory');
  const memory = await readMemory();
  assert.equal(memory.exists, true);
  assert.equal(memory.content, 'hello memory');
  assert.equal(memory.path, MEMORY_PATH);
});

test('readSoul returns missing state when soul file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { readSoul } = loadConfigStore(dir);
  const soul = await readSoul();
  assert.equal(soul.exists, false);
  assert.equal(soul.content, '');
  assert.match(soul.path, /soul\.md$/);
});

test('readSoul loads soul content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { readSoul, SOUL_PATH } = loadConfigStore(dir);
  await fs.mkdir(path.dirname(SOUL_PATH), { recursive: true });
  await fs.writeFile(SOUL_PATH, 'hello soul');
  const soul = await readSoul();
  assert.equal(soul.exists, true);
  assert.equal(soul.content, 'hello soul');
  assert.equal(soul.path, SOUL_PATH);
});

test('loadThreads returns empty map when threads file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { loadThreads } = loadConfigStore(dir);
  const threads = await loadThreads();
  assert.equal(threads.size, 0);
});

test('saveThreads writes and loadThreads reads threads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-config-'));
  const { loadThreads, saveThreads, THREADS_PATH } = loadConfigStore(dir);

  const input = new Map([
    [123, 'thread-123'],
    ['-456', 'thread-456'],
  ]);
  await saveThreads(input);

  const loaded = await loadThreads();
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get('123'), 'thread-123');
  assert.equal(loaded.get('-456'), 'thread-456');

  const raw = await fs.readFile(THREADS_PATH, 'utf8');
  assert.deepEqual(JSON.parse(raw), { 123: 'thread-123', '-456': 'thread-456' });
});

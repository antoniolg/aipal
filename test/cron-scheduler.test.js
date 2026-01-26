const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadCronScheduler(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const modulePath = path.join(__dirname, '..', 'src', 'cron-scheduler.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('loadCronJobs returns empty list when file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs } = loadCronScheduler(dir);
  const jobs = await loadCronJobs();
  assert.deepEqual(jobs, []);
});

test('saveCronJobs writes and loadCronJobs reads jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs, saveCronJobs, CRON_PATH } = loadCronScheduler(dir);

  const input = [
    { id: 'test', cron: '* * * * *', prompt: 'hi', enabled: true },
    { id: 'off', cron: '0 0 * * *', prompt: 'nope', enabled: false },
  ];
  await saveCronJobs(input);

  const loaded = await loadCronJobs();
  assert.deepEqual(loaded, input);

  const raw = await fs.readFile(CRON_PATH, 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: input });
});


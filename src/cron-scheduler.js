const cron = require('node-cron');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { CONFIG_DIR } = require('./config-store');

const CRON_PATH = path.join(CONFIG_DIR, 'cron.json');

async function loadCronJobs() {
  try {
    const raw = await fs.readFile(CRON_PATH, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    console.warn('Failed to load cron.json:', err);
    return [];
  }
}

async function saveCronJobs(jobs) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CRON_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ jobs }, null, 2));
  await fs.rename(tmpPath, CRON_PATH);
}

function startCronScheduler(options = {}) {
  const { onTrigger, chatId } = options;
  if (!onTrigger || !chatId) {
    console.warn('Cron scheduler requires onTrigger and chatId');
    return { tasks: new Map(), reload: () => {} };
  }

  const tasks = new Map();

  async function scheduleJobs() {
    // Stop existing tasks
    for (const [id, task] of tasks) {
      task.stop();
      tasks.delete(id);
    }

    const jobs = await loadCronJobs();
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (!job.id || !job.cron || !job.prompt) {
        console.warn('Invalid cron job, skipping:', job);
        continue;
      }
      if (!cron.validate(job.cron)) {
        console.warn(`Invalid cron expression for job ${job.id}: ${job.cron}`);
        continue;
      }

      const task = cron.schedule(job.cron, async () => {
        console.info(`Cron triggered: ${job.id}`);
        try {
          await onTrigger(chatId, job.prompt, { jobId: job.id });
        } catch (err) {
          console.error(`Cron job ${job.id} failed:`, err);
        }
      }, {
        timezone: job.timezone || 'Europe/Madrid',
      });

      tasks.set(job.id, task);
      console.info(`Cron scheduled: ${job.id} (${job.cron})`);
    }

    return tasks.size;
  }

  // Initial load
  scheduleJobs().then((count) => {
    console.info(`Cron scheduler started with ${count} job(s)`);
  }).catch((err) => {
    console.error('Failed to start cron scheduler:', err);
  });

  return {
    tasks,
    reload: scheduleJobs,
  };
}

module.exports = {
  CRON_PATH,
  loadCronJobs,
  saveCronJobs,
  startCronScheduler,
};

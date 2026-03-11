require('dotenv').config();

const { Telegraf } = require('telegraf');
const {
  AGENT_CODEX,
  getAgent,
  getAgentLabel,
  isKnownAgent,
  normalizeAgent,
} = require('./agents');
const {
  CONFIG_PATH,
  MEMORY_PATH,
  SOUL_PATH,
  TOOLS_PATH,
  loadAgentOverrides,
  loadThreads,
  readConfig,
  readMemory,
  readSoul,
  readTools,
  saveAgentOverrides,
  saveThreads,
  updateConfig,
} = require('./config-store');
const {
  clearAgentOverride,
  getAgentOverride,
  setAgentOverride,
} = require('./agent-overrides');
const {
  buildThreadKey,
  buildTopicKey,
  clearThreadForAgent,
  normalizeTopicId,
  resolveThreadId,
} = require('./thread-store');
const {
  appendMemoryEvent,
  buildThreadBootstrap,
  curateMemory,
  getMemoryStatus,
  getThreadTail,
} = require('./memory-store');
const {
  buildMemoryRetrievalContext,
  searchMemory,
} = require('./memory-retrieval');
const {
  loadCronJobs,
  loadCronState,
  saveCronJobs,
  buildCronTriggerPayload,
  startCronScheduler,
} = require('./cron-scheduler');
const {
  chunkText,
  formatError,
  parseSlashCommand,
  extractCommandValue,
  extensionFromMime,
  extensionFromUrl,
  getAudioPayload,
  getImagePayload,
  getDocumentPayload,
  isPathInside,
  extractImageTokens,
  extractDocumentTokens,
  extractScheduleOnceTokens,
  chunkMarkdown,
  markdownToTelegramHtml,
  buildPrompt,
} = require('./message-utils');
const {
  isModelResetCommand,
  clearModelOverride,
} = require('./model-settings');
const {
  createAccessControlMiddleware,
  parseAllowedUsersEnv,
} = require('./access-control');

const { ScriptManager } = require('./script-manager');
const { prefixTextWithTimestamp, DEFAULT_TIME_ZONE } = require('./time-utils');
const { installLogTimestamps } = require('./app/logging');
const {
  AGENT_MAX_BUFFER,
  AGENT_TIMEOUT_MS,
  DOCUMENT_CLEANUP_INTERVAL_MS,
  DOCUMENT_DIR,
  DOCUMENT_TTL_HOURS,
  FILE_INSTRUCTIONS_EVERY,
  IMAGE_CLEANUP_INTERVAL_MS,
  IMAGE_DIR,
  IMAGE_TTL_HOURS,
  MEMORY_CURATE_EVERY,
  MEMORY_RETRIEVAL_LIMIT,
  SCRIPT_NAME_REGEX,
  SCRIPTS_DIR,
  SCRIPT_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  WHISPER_CMD,
  WHISPER_LANGUAGE,
  WHISPER_MODEL,
  WHISPER_TIMEOUT_MS,
  HTTP_PORT,
  HTTP_AUTH_TOKEN,
} = require('./app/env');
const { createAppState } = require('./app/state');
const {
  execLocal,
  execLocalStreaming,
  shellQuote,
  wrapCommandWithPty,
} = require('./services/process');
const { createEnqueue } = require('./services/queue');
const { createAgentRunner } = require('./services/agent-runner');
const { createCronAlertNotifier } = require('./services/cron-alerts');
const { createCronHandler } = require('./services/cron-handler');
const {
  buildCronInspection,
  formatCronInspection,
  formatRunsMessage,
  listRecentRuns,
} = require('./services/cron-observability');
const {
  cancelScheduledRun,
  createScheduledRun,
  formatScheduledRun,
  listScheduledRuns: listScheduledRunsFile,
  loadScheduledRuns,
} = require('./services/scheduled-runs');
const { createFileService } = require('./services/files');
const { createMemoryService } = require('./services/memory');
const { createScriptService } = require('./services/scripts');
const { createTelegramReplyService } = require('./services/telegram-reply');
const { createHttpServerService } = require('./services/http-server');
const { startOneShotScheduler } = require('./one-shot-scheduler');
const { bootstrapApp } = require('./app/bootstrap');
const { initializeApp, installShutdownHooks } = require('./app/lifecycle');
const { registerCommands } = require('./app/register-commands');
const { registerHandlers } = require('./app/register-handlers');

installLogTimestamps();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const allowedUsers = parseAllowedUsersEnv(process.env.ALLOWED_USERS);

// Access control middleware: must be registered before any other handlers
if (allowedUsers.size > 0) {
  console.log(`Configured with ${allowedUsers.size} allowed users.`);
  bot.use(
    createAccessControlMiddleware(allowedUsers, {
      onUnauthorized: ({ userId, username }) => {
        console.warn(
          `Unauthorized access attempt from user ID ${userId} (${username || 'no username'
          })`
        );
      },
    })
  );
} else {
  console.warn(
    'WARNING: No ALLOWED_USERS configured. The bot is open to everyone.'
  );
}

const appState = createAppState({ defaultAgent: AGENT_CODEX });
const { queues, threadTurns, lastScriptOutputs } = appState;
let { threads, threadsPersist, agentOverrides, agentOverridesPersist, memoryPersist } = appState;
const SCRIPT_CONTEXT_MAX_CHARS = 8000;
let memoryEventsSinceCurate = 0;
let globalThinking;
let globalAgent = AGENT_CODEX;
let globalModels = {};
let cronDefaultChatId = null;
let oneShotScheduler = null;
const enqueue = createEnqueue(queues);

const scriptManager = new ScriptManager(SCRIPTS_DIR);
const scriptService = createScriptService({
  execLocal,
  isPathInside,
  scriptNameRegex: SCRIPT_NAME_REGEX,
  scriptsDir: SCRIPTS_DIR,
  scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
  scriptContextMaxChars: SCRIPT_CONTEXT_MAX_CHARS,
  lastScriptOutputs,
});
const { consumeScriptContext, formatScriptContext, runScriptCommand } = scriptService;

const fileService = createFileService({
  execLocal,
  extensionFromMime,
  extensionFromUrl,
  imageCleanupIntervalMs: IMAGE_CLEANUP_INTERVAL_MS,
  imageDir: IMAGE_DIR,
  imageTtlHours: IMAGE_TTL_HOURS,
  whisperCmd: WHISPER_CMD,
  whisperLanguage: WHISPER_LANGUAGE,
  whisperModel: WHISPER_MODEL,
  whisperTimeoutMs: WHISPER_TIMEOUT_MS,
  documentCleanupIntervalMs: DOCUMENT_CLEANUP_INTERVAL_MS,
  documentDir: DOCUMENT_DIR,
  documentTtlHours: DOCUMENT_TTL_HOURS,
});
const {
  downloadTelegramFile,
  safeUnlink,
  startDocumentCleanup,
  startImageCleanup,
  transcribeAudio,
} = fileService;

const memoryService = createMemoryService({
  appendMemoryEvent,
  buildThreadBootstrap,
  configPath: CONFIG_PATH,
  curateMemory,
  documentDir: DOCUMENT_DIR,
  extractDocumentTokens,
  extractImageTokens,
  extractScheduleOnceTokens,
  imageDir: IMAGE_DIR,
  memoryCurateEvery: MEMORY_CURATE_EVERY,
  memoryPath: MEMORY_PATH,
  persistMemory,
  readMemory,
  readSoul,
  readTools,
  soulPath: SOUL_PATH,
  toolsPath: TOOLS_PATH,
  getMemoryEventsSinceCurate: () => memoryEventsSinceCurate,
  setMemoryEventsSinceCurate: (value) => {
    memoryEventsSinceCurate = value;
  },
});
const { buildBootstrapContext, captureMemoryEvent, extractMemoryText } = memoryService;

const agentRunner = createAgentRunner({
  agentMaxBuffer: AGENT_MAX_BUFFER,
  agentTimeoutMs: AGENT_TIMEOUT_MS,
  buildBootstrapContext,
  buildMemoryRetrievalContext,
  buildPrompt,
  documentDir: DOCUMENT_DIR,
  execLocal,
  execLocalStreaming,
  fileInstructionsEvery: FILE_INSTRUCTIONS_EVERY,
  getAgent,
  getAgentLabel,
  getGlobalAgent: () => globalAgent,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getThreads: () => threads,
  imageDir: IMAGE_DIR,
  memoryRetrievalLimit: MEMORY_RETRIEVAL_LIMIT,
  persistThreads,
  prefixTextWithTimestamp,
  resolveEffectiveAgentId,
  resolveThreadId,
  shellQuote,
  threadTurns,
  wrapCommandWithPty,
  defaultTimeZone: DEFAULT_TIME_ZONE,
});
const { runAgentForChat, runAgentOneShot } = agentRunner;

const telegramReplyService = createTelegramReplyService({
  bot,
  chunkMarkdown,
  chunkText,
  createScheduledRun,
  documentDir: DOCUMENT_DIR,
  extractDocumentTokens,
  extractImageTokens,
  extractScheduleOnceTokens,
  formatError,
  imageDir: IMAGE_DIR,
  isPathInside,
  markdownToTelegramHtml,
  resolveEffectiveAgentId,
});
const {
  createChatProgressReporter,
  createReplyProgressReporter,
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  sendResponseToChat,
  startTyping,
} = telegramReplyService;

const httpServerService = createHttpServerService({
  port: HTTP_PORT,
  authToken: HTTP_AUTH_TOKEN,
  onMessageReceived: async (payload) => {
    const targetChatId =
      payload.chatId ||
      cronDefaultChatId ||
      (allowedUsers.size > 0 ? Array.from(allowedUsers)[0] : null);

    if (!targetChatId) {
      throw new Error(
        'No target chatId configured (need either payload.chatId, cronChatId config, or ALLOWED_USERS array)'
      );
    }

    await sendResponseToChat(targetChatId, payload.text, {
      topicId: payload.topicId,
    });
  },
});

const handleCronTrigger = createCronHandler({
  bot,
  buildTopicKey,
  buildMemoryThreadKey,
  captureMemoryEvent,
  enqueue,
  extractMemoryText,
  resolveEffectiveAgentId,
  runAgentForChat,
  sendResponseToChat,
});
const notifyCronAlert = createCronAlertNotifier({ bot });

bot.catch((err) => {
  console.error('Bot error', err);
});

function persistThreads() {
  threadsPersist = threadsPersist
    .catch(() => { })
    .then(() => saveThreads(threads));
  return threadsPersist;
}

function persistAgentOverrides() {
  agentOverridesPersist = agentOverridesPersist
    .catch(() => { })
    .then(() => saveAgentOverrides(agentOverrides));
  return agentOverridesPersist;
}

function persistMemory(task) {
  memoryPersist = memoryPersist
    .catch(() => { })
    .then(task);
  return memoryPersist;
}

function resolveEffectiveAgentId(chatId, topicId, overrideAgentId) {
  return (
    overrideAgentId ||
    getAgentOverride(agentOverrides, chatId, topicId) ||
    globalAgent
  );
}

function buildMemoryThreadKey(chatId, topicId, agentId) {
  return buildThreadKey(chatId, normalizeTopicId(topicId), agentId);
}

let cronScheduler = null;

async function hydrateGlobalSettings() {
  const config = await readConfig();
  if (config.agent) globalAgent = normalizeAgent(config.agent);
  if (config.models) globalModels = { ...config.models };
  return config;
}

function getTopicId(ctx) {
  return ctx?.message?.message_thread_id;
}

bot.start((ctx) => ctx.reply(`Ready. Send a message and I will pass it to ${getAgentLabel(globalAgent)}.`));
registerCommands({
  allowedUsers,
  bot,
  buildCronTriggerPayload,
  buildCronInspection,
  buildMemoryThreadKey,
  buildTopicKey,
  cancelScheduledRun,
  clearAgentOverride: (chatId, topicId) =>
    clearAgentOverride(agentOverrides, chatId, topicId),
  clearModelOverride,
  clearThreadForAgent: (chatId, topicId, agentId) =>
    clearThreadForAgent(threads, chatId, topicId, agentId),
  curateMemory,
  enqueue,
  execLocal,
  extractCommandValue,
  formatCronInspection,
  formatScheduledRun,
  formatRunsMessage,
  getAgent,
  getAgentLabel,
  getAgentOverride: (chatId, topicId) =>
    getAgentOverride(agentOverrides, chatId, topicId),
  getCronDefaultChatId: () => cronDefaultChatId,
  getCronScheduler: () => cronScheduler,
  getOneShotScheduler: () => oneShotScheduler,
  getGlobalAgent: () => globalAgent,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getMemoryStatus,
  getThreadTail,
  getTopicId,
  handleCronTrigger,
  isKnownAgent,
  isModelResetCommand,
  loadCronJobs,
  loadCronState,
  loadScheduledRuns,
  listRecentRuns,
  listScheduledRuns: listScheduledRunsFile,
  markdownToTelegramHtml,
  memoryRetrievalLimit: MEMORY_RETRIEVAL_LIMIT,
  normalizeAgent,
  normalizeTopicId,
  persistAgentOverrides,
  persistMemory,
  persistThreads,
  replyWithError,
  resolveEffectiveAgentId,
  createScheduledRun,
  saveCronJobs,
  scriptManager,
  searchMemory,
  setAgentOverride: (chatId, topicId, agentId) =>
    setAgentOverride(agentOverrides, chatId, topicId, agentId),
  setGlobalAgent: (value) => {
    globalAgent = value;
  },
  setGlobalModels: (value) => {
    globalModels = value;
  },
  setGlobalThinking: (value) => {
    globalThinking = value;
  },
  setMemoryEventsSinceCurate: (value) => {
    memoryEventsSinceCurate = value;
  },
  startTyping,
  threadTurns,
  updateConfig,
  wrapCommandWithPty,
  runAgentOneShot,
});

registerHandlers({
  bot,
  buildMemoryThreadKey,
  buildTopicKey,
  captureMemoryEvent,
  consumeScriptContext,
  createReplyProgressReporter,
  documentDir: DOCUMENT_DIR,
  downloadTelegramFile,
  enqueue,
  extractMemoryText,
  formatScriptContext,
  getAudioPayload,
  getDocumentPayload,
  getImagePayload,
  getTopicId,
  imageDir: IMAGE_DIR,
  lastScriptOutputs,
  parseSlashCommand,
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  resolveEffectiveAgentId,
  runAgentForChat,
  runScriptCommand,
  safeUnlink,
  scriptManager,
  startTyping,
  transcribeAudio,
});

bootstrapApp({
  bot,
  initializeApp: () =>
    initializeApp({
      handleCronTrigger,
      notifyCronAlert,
      hydrateGlobalSettings,
      loadAgentOverrides,
      loadThreads,
      setAgentOverrides: (value) => {
        agentOverrides = value;
      },
      setCronDefaultChatId: (value) => {
        cronDefaultChatId = value;
      },
      setCronScheduler: (value) => {
        cronScheduler = value;
      },
      setOneShotScheduler: (value) => {
        oneShotScheduler = value;
      },
      setThreads: (value) => {
        threads = value;
      },
      startCronScheduler,
      startOneShotScheduler,
      startDocumentCleanup,
      startImageCleanup,
      startHttpServer: httpServerService.start,
    }),
  installShutdownHooks: () =>
    installShutdownHooks({
      bot,
      getCronScheduler: () => cronScheduler,
      getOneShotScheduler: () => oneShotScheduler,
      getPersistPromises: () => [threadsPersist, agentOverridesPersist, memoryPersist],
      getQueues: () => queues,
      shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
      stopHttpServer: httpServerService.stop,
    }),
});

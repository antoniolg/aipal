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
  AGENT_CWD,
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
} = require('./app/env');
const { createAppState } = require('./app/state');
const { execLocal, shellQuote, wrapCommandWithPty } = require('./services/process');
const { createEnqueue } = require('./services/queue');
const { createAgentRunner } = require('./services/agent-runner');
const {
  getLocalCodexSessionLastMessage,
  isValidSessionId,
  listLocalCodexSessions,
} = require('./services/codex-sessions');
const { createCronHandler } = require('./services/cron-handler');
const { createFileService } = require('./services/files');
const { createMemoryService } = require('./services/memory');
const { createScriptService } = require('./services/scripts');
const { createTelegramReplyService } = require('./services/telegram-reply');
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

function buildPersistentKeyboard() {
  return {
    keyboard: [
      [{ text: 'Project' }, { text: 'Sesiones' }],
      [{ text: 'Reanudar última' }],
      [{ text: 'Ocultar teclado' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Access control middleware: must be registered before any other handlers
if (allowedUsers.size > 0) {
  console.log(`Configured with ${allowedUsers.size} allowed users.`);
  bot.use(
    createAccessControlMiddleware(allowedUsers, {
      onUnauthorized: ({ userId, username }) => {
        console.warn(
          `Unauthorized access attempt from user ID ${userId} (${
            username || 'no username'
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
let globalAgentCwd = AGENT_CWD;
let cronDefaultChatId = null;
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
  fileInstructionsEvery: FILE_INSTRUCTIONS_EVERY,
  getAgent,
  getAgentLabel,
  getGlobalAgent: () => globalAgent,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getAgentCwd: () => globalAgentCwd,
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
  documentDir: DOCUMENT_DIR,
  extractDocumentTokens,
  extractImageTokens,
  formatError,
  imageDir: IMAGE_DIR,
  isPathInside,
  markdownToTelegramHtml,
});
const {
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  sendResponseToChat,
  startTyping,
} = telegramReplyService;

const handleCronTrigger = createCronHandler({
  bot,
  buildMemoryThreadKey,
  captureMemoryEvent,
  extractMemoryText,
  resolveEffectiveAgentId,
  runAgentForChat,
  sendResponseToChat,
});

bot.catch((err) => {
  console.error('Bot error', err);
});

function persistThreads() {
  threadsPersist = threadsPersist
    .catch(() => {})
    .then(() => saveThreads(threads));
  return threadsPersist;
}

function persistAgentOverrides() {
  agentOverridesPersist = agentOverridesPersist
    .catch(() => {})
    .then(() => saveAgentOverrides(agentOverrides));
  return agentOverridesPersist;
}

function persistMemory(task) {
  memoryPersist = memoryPersist
    .catch(() => {})
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
  if (typeof config.agentCwd === 'string' && config.agentCwd.trim()) {
    globalAgentCwd = config.agentCwd;
  }
  return config;
}

function getTopicId(ctx) {
  return ctx?.message?.message_thread_id;
}

function setThreadForAgent(chatId, topicId, agentId, threadId) {
  const key = buildThreadKey(chatId, normalizeTopicId(topicId), agentId);
  threads.set(key, String(threadId || '').trim());
}

bot.start(async (ctx) => {
  await ctx.reply(
    `Ready. Send a message and I will pass it to ${getAgentLabel(globalAgent)}.`,
    {
      reply_markup: buildPersistentKeyboard(),
    }
  );
});
registerCommands({
  allowedUsers,
  bot,
  buildCronTriggerPayload,
  buildMemoryThreadKey,
  buildTopicKey,
  clearAgentOverride: (chatId, topicId) =>
    clearAgentOverride(agentOverrides, chatId, topicId),
  clearModelOverride,
  clearThreadForAgent: (chatId, topicId, agentId) =>
    clearThreadForAgent(threads, chatId, topicId, agentId),
  curateMemory,
  enqueue,
  execLocal,
  extractCommandValue,
  getAgent,
  getAgentLabel,
  getAgentOverride: (chatId, topicId) =>
    getAgentOverride(agentOverrides, chatId, topicId),
  getCronDefaultChatId: () => cronDefaultChatId,
  getCronScheduler: () => cronScheduler,
  getGlobalAgent: () => globalAgent,
  getGlobalAgentCwd: () => globalAgentCwd,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getThreads: () => threads,
  getMemoryStatus,
  getThreadTail,
  getTopicId,
  handleCronTrigger,
  isKnownAgent,
  getLocalCodexSessionLastMessage,
  isValidSessionId,
  isModelResetCommand,
  loadCronJobs,
  listLocalCodexSessions,
  markdownToTelegramHtml,
  memoryRetrievalLimit: MEMORY_RETRIEVAL_LIMIT,
  normalizeAgent,
  normalizeTopicId,
  persistAgentOverrides,
  persistMemory,
  persistThreads,
  replyWithError,
  resolveThreadId,
  resolveEffectiveAgentId,
  saveCronJobs,
  scriptManager,
  searchMemory,
  setAgentOverride: (chatId, topicId, agentId) =>
    setAgentOverride(agentOverrides, chatId, topicId, agentId),
  setGlobalAgent: (value) => {
    globalAgent = value;
  },
  setGlobalAgentCwd: (value) => {
    globalAgentCwd = String(value || '').trim();
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
  setThreadForAgent,
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
      setThreads: (value) => {
        threads = value;
      },
      startCronScheduler,
      startDocumentCleanup,
      startImageCleanup,
    }),
  installShutdownHooks: () =>
    installShutdownHooks({
      bot,
      getCronScheduler: () => cronScheduler,
      getPersistPromises: () => [threadsPersist, agentOverridesPersist, memoryPersist],
      getQueues: () => queues,
      shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
    }),
});

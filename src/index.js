require('dotenv').config();

const { Telegraf } = require('telegraf');
const {
  AGENT_CODEX,
  AGENT_CODEX_APP,
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
  AGENT_POST_FINAL_GRACE_MS,
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
const {
  execLocal,
  execLocalStreaming,
  shellQuote,
  terminateChildProcess,
  wrapCommandWithPty,
} = require('./services/process');
const { createEnqueue } = require('./services/queue');
const { createAgentRunner } = require('./services/agent-runner');
const { createCronAlertNotifier } = require('./services/cron-alerts');
const { createCronHandler } = require('./services/cron-handler');
const { createCodexAppServerClient } = require('./services/codex-app-server');
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
const { createApprovalService } = require('./services/approval-requests');
const { createCodexDesktopExportService } = require('./services/codex-desktop-export');
const { createFileService } = require('./services/files');
const { createMemoryService } = require('./services/memory');
const { createResumeThreadsService } = require('./services/resume-threads');
const { createSendToCodexService } = require('./services/send-to-codex');
const { createScriptService } = require('./services/scripts');
const { createTelegramReplyService } = require('./services/telegram-reply');
const { syncTelegramCommands } = require('./services/telegram-command-sync');
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

function buildCodexAppInputs(promptText, imagePaths = []) {
  const items = [];
  const normalizedPrompt = String(promptText || '').trim();
  if (normalizedPrompt) {
    items.push({ type: 'text', text: normalizedPrompt });
  }
  for (const imagePath of imagePaths) {
    items.push({ type: 'localImage', path: imagePath });
  }
  return items;
}

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

const approvalService = createApprovalService({ bot });
const codexAppServerClient = createCodexAppServerClient({ cwd: process.cwd() });
const codexDesktopExportService = createCodexDesktopExportService();

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
  postFinalGraceMs: AGENT_POST_FINAL_GRACE_MS,
  prefixTextWithTimestamp,
  resolveEffectiveAgentId,
  resolveThreadId,
  runSessionBackedChatTurn: async (options) => {
    if (options.agentId !== AGENT_CODEX_APP) {
      throw new Error(`Unsupported session-backed agent: ${options.agentId}`);
    }
    return codexAppServerClient.runChatTurn({
      approvalPolicy: 'on-request',
      cwd: options.cwd,
      effort: options.effort,
      includeAgentDeltas: options.chatId > 0,
      input: buildCodexAppInputs(options.prompt, options.imagePaths),
      model: options.model,
      onApprovalResolved: ({ requestId, threadId }) => {
        approvalService.resolveServerRequest({ requestId, threadId });
      },
      onFinalResponse: options.onFinalResponse,
      onProgressUpdate: options.onProgressUpdate,
      onTurnStarted: options.onTurnStarted,
      requestApproval: (request) =>
        approvalService.requestApproval(request, {
          chatId: options.chatId,
          topicId: options.topicId,
        }),
      sandboxPolicy: { type: 'dangerFullAccess' },
      threadId: options.threadId,
    });
  },
  runSessionBackedOneShot: async (options) => {
    if (options.agentId !== AGENT_CODEX_APP) {
      throw new Error(`Unsupported session-backed agent: ${options.agentId}`);
    }
    return codexAppServerClient.runOneShot({
      approvalPolicy: 'on-request',
      cwd: process.cwd(),
      effort: options.effort,
      input: buildCodexAppInputs(options.prompt, []),
      model: options.model,
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  },
  setSessionBackedThreadTitle: async (options) => {
    if (options.agentId !== AGENT_CODEX_APP) {
      throw new Error(`Unsupported session-backed agent: ${options.agentId}`);
    }
    return codexAppServerClient.setThreadName({
      name: options.title,
      threadId: options.threadId,
    });
  },
  steerSessionBackedTurn: async (options) => {
    if (options.agentId !== AGENT_CODEX_APP) {
      throw new Error(`Unsupported session-backed agent: ${options.agentId}`);
    }
    return codexAppServerClient.steerTurn({
      expectedTurnId: options.turnId,
      input: options.input,
      threadId: options.threadId,
    });
  },
  stopSessionBackedTurn: async (options) => {
    if (options.agentId !== AGENT_CODEX_APP) {
      throw new Error(`Unsupported session-backed agent: ${options.agentId}`);
    }
    return codexAppServerClient.interruptTurn({
      threadId: options.threadId,
      turnId: options.turnId,
    });
  },
  shellQuote,
  terminateChildProcess,
  threadTurns,
  wrapCommandWithPty,
  defaultTimeZone: DEFAULT_TIME_ZONE,
});
const {
  cancelActiveRuns,
  getActiveRunState,
  runAgentForChat,
  runAgentOneShot,
  steerActiveRun,
  stopActiveRun,
} = agentRunner;

function getCodexAppThreadId(chatId, topicId) {
  return resolveThreadId(threads, chatId, topicId, AGENT_CODEX_APP).threadId;
}

function setThreadBinding(chatId, topicId, agentId, threadId) {
  const threadKey = buildThreadKey(chatId, normalizeTopicId(topicId), agentId);
  threads.set(threadKey, String(threadId));
  return persistThreads();
}

function formatThreadStatusMessage({
  activeRunState,
  effectiveAgentId,
  threadBinding,
  threadState,
}) {
  const lines = [
    `<b>Agente activo:</b> ${escapeHtml(getAgentLabel(effectiveAgentId))}`,
    `<b>Modelo de codex-app:</b> ${escapeHtml(globalModels[AGENT_CODEX_APP] || '(default)')}`,
    `<b>Reasoning:</b> ${escapeHtml(globalThinking || '(default)')}`,
    threadBinding
      ? `<b>Thread de codex-app:</b> <code>${escapeHtml(threadBinding)}</code>`
      : '<b>Thread de codex-app:</b> (sin binding)',
  ];

  if (threadState?.title) {
    lines.push(`<b>Titulo:</b> ${escapeHtml(threadState.title)}`);
  }
  if (threadState?.cwd) {
    lines.push(`<b>Proyecto:</b> <code>${escapeHtml(threadState.cwd)}</code>`);
  }
  if (threadState?.model) {
    lines.push(`<b>Modelo del thread:</b> ${escapeHtml(threadState.model)}`);
  }
  if (threadState?.reasoningEffort) {
    lines.push(`<b>Reasoning del thread:</b> ${escapeHtml(threadState.reasoningEffort)}`);
  }

  lines.push(
    activeRunState?.active
      ? `<b>Run activo:</b> si (${escapeHtml(activeRunState.lifecycleState || 'streaming')})`
      : '<b>Run activo:</b> no'
  );

  return lines.join('\n');
}

const resumeThreadsService = createResumeThreadsService({
  bot,
  onSelectThread: async (entry, ctx) => {
    await setThreadBinding(
      entry.chatId,
      entry.topicId,
      AGENT_CODEX_APP,
      entry.thread.threadId
    );
    const titleSuffix = entry.thread.title
      ? ` (${escapeHtml(entry.thread.title)})`
      : '';
    await ctx.editMessageText(
      `Sesion de codex-app reanudada: <code>${escapeHtml(entry.thread.threadId)}</code>${titleSuffix}`,
      {
        disable_web_page_preview: true,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      }
    );
    const effectiveAgentId = resolveEffectiveAgentId(entry.chatId, entry.topicId);
    if (effectiveAgentId !== AGENT_CODEX_APP) {
      await ctx.reply(
        `El binding se ha guardado para <b>codex-app</b>. El agente activo en este topic sigue siendo <b>${escapeHtml(getAgentLabel(
          effectiveAgentId
        ))}</b>.`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }
      );
    }
  },
});

const sendToCodexService = createSendToCodexService({
  bot,
  listProjects: () => codexDesktopExportService.listProjects(),
  onSendToCodex: async (entry) => {
    const sourceThreadId = entry?.sourceThread?.threadId;
    if (!sourceThreadId) {
      throw new Error('Missing source thread for send_to_codex');
    }
    const projectPath = String(entry?.project?.path || '').trim();
    if (!projectPath) {
      throw new Error('Missing destination project for send_to_codex');
    }

    const forkedThreadId = await codexAppServerClient.forkThread({
      threadId: sourceThreadId,
    });
    if (!forkedThreadId) {
      throw new Error(`thread/fork did not return a new thread id for ${sourceThreadId}`);
    }

    await codexDesktopExportService.promoteForkedThread({
      projectPath,
      threadId: forkedThreadId,
    });

    return {
      forkedThreadId,
      projectPath,
      sourceThreadId,
    };
  },
});

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
  createReplyProgressReporter,
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  sendResponseToChat,
  startTyping,
} = telegramReplyService;

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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  getActiveRunState,
  getCodexAppThreadId,
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
  listAgentModels: async (agentId) => {
    if (agentId !== AGENT_CODEX_APP) return '';
    const models = await codexAppServerClient.listModels();
    return models
      .map((entry) => {
        const efforts = Array.isArray(entry.effortOptions)
          ? ` [${entry.effortOptions.join(', ')}]`
          : '';
        return `${entry.id}${efforts}`;
      })
      .join('\n');
  },
  listResumeThreads: async ({ agentId, includeAipal, query }) => {
    if (agentId !== AGENT_CODEX_APP) return [];
    const threads = await codexAppServerClient.listThreads({ query });
    if (includeAipal) return threads;
    return threads.filter((thread) => thread?.originator !== 'aipal');
  },
  getSendToCodexSourceThread: async ({ agentId, chatId, topicId }) => {
    if (agentId !== AGENT_CODEX_APP) return null;
    const threadId = getCodexAppThreadId(chatId, topicId);
    if (!threadId) return null;
    const threads = await codexAppServerClient.listThreads({});
    const hit = threads.find((thread) => thread.threadId === threadId);
    if (!hit) {
      return { threadId };
    }
    if (hit.originator && hit.originator !== 'aipal') {
      return null;
    }
    return hit;
  },
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
  readResumeThreadState: async ({ chatId, effectiveAgentId, topicId }) => {
    const threadBinding = getCodexAppThreadId(chatId, topicId);
    const activeRunState = getActiveRunState(
      chatId,
      topicId,
      AGENT_CODEX_APP
    );
    let threadState = null;
    if (threadBinding) {
      try {
        threadState = await codexAppServerClient.readThreadState({
          threadId: threadBinding,
        });
      } catch (err) {
        console.warn('Failed to read codex-app thread state:', err?.message || err);
      }
    }
    return formatThreadStatusMessage({
      activeRunState,
      effectiveAgentId,
      threadBinding,
      threadState,
    });
  },
  resolveEffectiveAgentId,
  createScheduledRun,
  saveCronJobs,
  scriptManager,
  searchMemory,
  sendResumeThreadPicker: (ctx, params) =>
    resumeThreadsService.sendThreadPicker(ctx, params),
  sendToCodexPicker: (ctx, sourceThread) =>
    sendToCodexService.sendProjectPicker(ctx, sourceThread),
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
  stopActiveRun,
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
  handleCallbackQuery: async (ctx) => {
    const approvalHandled = await approvalService.handleCallbackQuery(ctx);
    if (approvalHandled) return true;
    const resumeHandled = await resumeThreadsService.handleCallbackQuery(ctx);
    if (resumeHandled) return true;
    return sendToCodexService.handleCallbackQuery(ctx);
  },
  imageDir: IMAGE_DIR,
  lastScriptOutputs,
  parseSlashCommand,
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  resolveEffectiveAgentId,
  runAgentForChat,
  steerActiveRun,
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
    }),
  syncBotCommands: () => syncTelegramCommands(bot),
  installShutdownHooks: () =>
    installShutdownHooks({
      bot,
      cancelActiveRuns,
      getCronScheduler: () => cronScheduler,
      getOneShotScheduler: () => oneShotScheduler,
      getPersistPromises: () => [threadsPersist, agentOverridesPersist, memoryPersist],
      getQueues: () => queues,
      shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
      stopCodexAppServer: async () => {
        approvalService.shutdown();
        resumeThreadsService.shutdown();
        await codexAppServerClient.shutdown();
      },
    }),
});

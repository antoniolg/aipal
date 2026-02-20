require('dotenv').config();

const { Telegraf } = require('telegraf');
const { randomUUID } = require('crypto');
const { constants: fsConstants } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
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
let cronDefaultChatId = null;
const enqueue = createEnqueue(queues);

const scriptManager = new ScriptManager(SCRIPTS_DIR);

bot.command('help', async (ctx) => {
  const builtIn = [
    '/start - Hello world',
    '/agent <name> - Switch agent (codex, claude, gemini, opencode)',
    '/thinking <level> - Set reasoning effort',
    '/model [model_id|reset] - View/set/reset model for current agent',
    '/memory [status|tail|search|curate] - Memory capture + retrieval + curation',
    '/reset - Reset current agent session',
    '/cron [list|reload|chatid|assign|unassign|run] - Manage cron jobs',
    '/help - Show this help',
    '/document_scripts confirm - Auto-document available scripts (requires ALLOWED_USERS)',
  ];

  let scripts = [];
  try {
    scripts = await scriptManager.listScripts();
  } catch (err) {
    console.error('Failed to list scripts', err);
    scripts = [];
  }

  const scriptLines = scripts.map((s) => {
    const llmTag = s.llm?.prompt ? ' [LLM]' : '';
    const desc = s.description ? ` - ${s.description}` : '';
    return `- /${s.name}${llmTag}${desc}`;
  });

  const messageMd = [
    '**Built-in commands:**',
    ...builtIn.map((line) => `- ${line}`),
    '',
    '**Scripts:**',
    ...(scriptLines.length ? scriptLines : ['(none)']),
  ].join('\n');

  const message = markdownToTelegramHtml(messageMd);
  ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('document_scripts', async (ctx) => {
  const chatId = ctx.chat.id;
  if (allowedUsers.size === 0) {
    await ctx.reply('ALLOWED_USERS is not configured. /document_scripts is disabled.');
    return;
  }

  const value = extractCommandValue(ctx.message.text);
  const confirmed = value === 'confirm' || value === '--yes';
  if (!confirmed) {
    await ctx.reply(
      [
        'This will send the first 2000 chars of each script to the active agent',
        'to generate a short description and write it to `scripts.json`.',
        '',
        'Run `/document_scripts confirm` to proceed.',
      ].join('\n'),
    );
    return;
  }

  await ctx.reply('Scanning for undocumented scripts...');

  enqueue(chatId, async () => {
    let scripts = [];
    try {
      scripts = await scriptManager.listScripts();
    } catch (err) {
      await replyWithError(ctx, 'Failed to list scripts', err);
      return;
    }

    const undocumented = scripts.filter((script) => !script.description);
    if (undocumented.length === 0) {
      await ctx.reply('All scripts are already documented!');
      return;
    }

    await ctx.reply(`Found ${undocumented.length} undocumented scripts. Processing...`);

    const stopTyping = startTyping(ctx);
    try {
      for (const script of undocumented) {
        try {
          const content = await scriptManager.getScriptContent(script.name);
          const prompt = [
            'Analyze the following script and provide a very short description (max 10 words).',
            'Return ONLY the description (no quotes, no extra text).',
            '',
            'Script:',
            content.slice(0, 2000),
          ].join('\n');

          const description = await runAgentOneShot(prompt);
          const cleaned = String(description || '')
            .split(/\r?\n/)[0]
            .trim()
            .replace(/^['"]|['"]$/g, '')
            .slice(0, 140);

          if (!cleaned) {
            await ctx.reply(`Skipped ${script.name}: empty description`);
            continue;
          }

          await scriptManager.updateScriptMetadata(script.name, { description: cleaned });
          await ctx.reply(`Documented ${script.name}: ${cleaned}`);
        } catch (err) {
          console.error(`Failed to document ${script.name}`, err);
          await ctx.reply(`Failed to document ${script.name}: ${err.message}`);
        }
      }
    } finally {
      stopTyping();
    }

    await ctx.reply('Documentation complete. Use /help to see the results.');
  });
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

function extractMemoryText(response) {
  const { cleanedText: withoutImages } = extractImageTokens(
    response || '',
    IMAGE_DIR
  );
  const { cleanedText } = extractDocumentTokens(withoutImages, DOCUMENT_DIR);
  return String(cleanedText || '').trim();
}

function maybeAutoCurateMemory() {
  memoryEventsSinceCurate += 1;
  if (memoryEventsSinceCurate < MEMORY_CURATE_EVERY) return;
  memoryEventsSinceCurate = 0;
  persistMemory(async () => {
    try {
      const result = await curateMemory();
      console.info(
        `Auto-curated memory events=${result.eventsProcessed} bytes=${result.bytes}`
      );
    } catch (err) {
      console.warn('Auto memory curation failed:', err);
    }
  }).catch((err) => {
    console.warn('Failed to schedule auto memory curation:', err);
  });
}

async function captureMemoryEvent(event) {
  try {
    await appendMemoryEvent(event);
    maybeAutoCurateMemory();
  } catch (err) {
    console.warn('Failed to append memory event:', err);
  }
}

async function buildBootstrapContext(options = {}) {
  const { threadKey } = options;
  const soul = await readSoul();
  const tools = await readTools();
  const memory = await readMemory();
  const lines = [
    'Bootstrap config:',
    `Config JSON: ${CONFIG_PATH}`,
    `Soul file: ${SOUL_PATH}`,
    `Tools file: ${TOOLS_PATH}`,
    `Memory file: ${MEMORY_PATH}`,
  ];
  if (soul.exists && soul.content) {
    lines.push('Soul (soul.md):');
    lines.push(soul.content);
    lines.push('End of soul.');
  }
  if (tools.exists && tools.content) {
    lines.push('Tools (tools.md):');
    lines.push(tools.content);
    lines.push('End of tools.');
  }
  if (memory.exists && memory.content) {
    lines.push('Memory (memory.md):');
    lines.push(memory.content);
    lines.push('End of memory.');
  }
  if (threadKey) {
    const threadBootstrap = await buildThreadBootstrap(threadKey);
    if (threadBootstrap) {
      lines.push(threadBootstrap);
      lines.push('End of thread memory.');
    }
  }
  return lines.join('\n');
}

let cronScheduler = null;

async function hydrateGlobalSettings() {
  const config = await readConfig();
  if (config.agent) globalAgent = normalizeAgent(config.agent);
  if (config.models) globalModels = { ...config.models };
  return config;
}

function splitArgs(input) {
  const args = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

async function runScriptCommand(commandName, rawArgs) {
  if (!SCRIPT_NAME_REGEX.test(commandName)) {
    throw new Error(`Invalid script name: ${commandName}`);
  }
  const scriptPath = path.resolve(SCRIPTS_DIR, commandName);
  if (!isPathInside(SCRIPTS_DIR, scriptPath)) {
    throw new Error(`Invalid script path: ${scriptPath}`);
  }
  try {
    await fs.access(scriptPath, fsConstants.X_OK);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Script not found: ${scriptPath}`);
    }
    if (err && err.code === 'EACCES') {
      throw new Error(`Script not executable: ${scriptPath}`);
    }
    throw err;
  }
  const argv = splitArgs(rawArgs || '');
  return execLocal(scriptPath, argv, {
    timeout: SCRIPT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function formatScriptContext(entry) {
  if (!entry) return '';
  const output = String(entry.output || '').trim() || '(no output)';
  if (output.length <= SCRIPT_CONTEXT_MAX_CHARS) {
    return `/${entry.name} output:\n${output}`;
  }
  const truncated = output.slice(0, SCRIPT_CONTEXT_MAX_CHARS);
  const remaining = output.length - SCRIPT_CONTEXT_MAX_CHARS;
  return `/${entry.name} output (truncated ${remaining} chars):\n${truncated}`;
}

function consumeScriptContext(topicKey) {
  const entry = lastScriptOutputs.get(topicKey);
  if (!entry) return '';
  lastScriptOutputs.delete(topicKey);
  return formatScriptContext(entry);
}

function getTopicId(ctx) {
  return ctx?.message?.message_thread_id;
}

async function replyWithError(ctx, label, err) {
  const detail = formatError(err);
  const text = `${label}\n${detail}`.trim();
  for (const chunk of chunkText(text, 3500)) {
    await ctx.reply(chunk);
  }
}

function startTyping(ctx) {
  const send = async () => {
    try {
      await ctx.sendChatAction('typing');
    } catch (err) {
      console.error('Typing error', err);
    }
  };
  send();
  const timer = setInterval(send, 4000);
  return () => clearInterval(timer);
}

async function downloadTelegramFile(ctx, payload, options = {}) {
  const {
    dir = path.join(os.tmpdir(), 'aipal'),
    prefix = 'file',
    errorLabel = 'file',
  } = options;
  const link = await ctx.telegram.getFileLink(payload.fileId);
  const url = typeof link === 'string' ? link : link.href;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${errorLabel} (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(dir, { recursive: true });
  const extFromName = payload.fileName ? path.extname(payload.fileName) : '';
  const ext = extFromName || extensionFromMime(payload.mimeType) || extensionFromUrl(url) || '.bin';
  const filePath = path.join(dir, `${prefix}-${randomUUID()}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function transcribeAudio(audioPath) {
  const outputDir = path.join(os.tmpdir(), 'whisper-mlx');
  await fs.mkdir(outputDir, { recursive: true });
  const outputName = `whisper-${randomUUID()}`;
  const args = [
    audioPath,
    '--model', WHISPER_MODEL,
    '--language', WHISPER_LANGUAGE,
    '--output-dir', outputDir,
    '--output-format', 'txt',
    '--output-name', outputName,
    '--condition-on-previous-text', 'False',
    '--word-timestamps', 'True',
    '--hallucination-silence-threshold', '2',
  ];
  await execLocal(WHISPER_CMD, args, { timeout: WHISPER_TIMEOUT_MS });
  const outputPath = path.join(outputDir, `${outputName}.txt`);
  const text = await fs.readFile(outputPath, 'utf8');
  return { text: text.trim(), outputPath };
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch { }
}

async function cleanupOldFiles(dir, maxAgeMs, label) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await safeUnlink(filePath);
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`${label} cleanup failed:`, err);
    }
  }
}

function startImageCleanup() {
  if (!Number.isFinite(IMAGE_TTL_HOURS) || IMAGE_TTL_HOURS <= 0) return;
  const maxAgeMs = IMAGE_TTL_HOURS * 60 * 60 * 1000;
  const run = () => cleanupOldFiles(IMAGE_DIR, maxAgeMs, 'Image');
  run();
  if (Number.isFinite(IMAGE_CLEANUP_INTERVAL_MS) && IMAGE_CLEANUP_INTERVAL_MS > 0) {
    const timer = setInterval(run, IMAGE_CLEANUP_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

function startDocumentCleanup() {
  if (!Number.isFinite(DOCUMENT_TTL_HOURS) || DOCUMENT_TTL_HOURS <= 0) return;
  const maxAgeMs = DOCUMENT_TTL_HOURS * 60 * 60 * 1000;
  const run = () => cleanupOldFiles(DOCUMENT_DIR, maxAgeMs, 'Document');
  run();
  if (Number.isFinite(DOCUMENT_CLEANUP_INTERVAL_MS) && DOCUMENT_CLEANUP_INTERVAL_MS > 0) {
    const timer = setInterval(run, DOCUMENT_CLEANUP_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

async function runAgentOneShot(prompt) {
  const agent = getAgent(globalAgent);
  const thinking = globalThinking;
  let promptText = String(prompt || '');
  if (agent.id === 'claude') {
    promptText = prefixTextWithTimestamp(promptText, { timeZone: DEFAULT_TIME_ZONE });
  }
  const promptBase64 = Buffer.from(promptText, 'utf8').toString('base64');
  const promptExpression = '"$PROMPT"';
  const agentCmd = agent.buildCommand({
    prompt: promptText,
    promptExpression,
    threadId: undefined,
    thinking,
  });

  const command = [
    `PROMPT_B64=${shellQuote(promptBase64)};`,
    'PROMPT=$(printf %s "$PROMPT_B64" | base64 --decode);',
    `${agentCmd}`,
  ].join(' ');

  let commandToRun = command;
  if (agent.needsPty) {
    commandToRun = wrapCommandWithPty(commandToRun);
  }
  if (agent.mergeStderr) {
    commandToRun = `${commandToRun} 2>&1`;
  }

  const startedAt = Date.now();
  console.info(`Agent one-shot start agent=${getAgentLabel(globalAgent)}`);
  let output;
  let execError;
  try {
    output = await execLocal('bash', ['-lc', commandToRun], {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: AGENT_MAX_BUFFER,
    });
  } catch (err) {
    execError = err;
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
      output = err.stdout;
    } else {
      throw err;
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    console.info(`Agent one-shot finished durationMs=${elapsedMs}`);
  }

  const parsed = agent.parseOutput(output);
  if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
    throw execError;
  }
  if (execError) {
    console.warn(
      `Agent one-shot exited non-zero; returning stdout (code=${execError.code || 'unknown'})`
    );
  }
  return parsed.text || output;
}

async function runAgentForChat(chatId, prompt, options = {}) {
  const { topicId, agentId: overrideAgentId } = options;
  const effectiveAgentId = resolveEffectiveAgentId(
    chatId,
    topicId,
    overrideAgentId
  );
  const agent = getAgent(effectiveAgentId);

  const { threadKey, threadId, migrated } = resolveThreadId(
    threads,
    chatId,
    topicId,
    effectiveAgentId
  );
  const turnCount = (threadTurns.get(threadKey) || 0) + 1;
  threadTurns.set(threadKey, turnCount);
  const shouldIncludeFileInstructions =
    !threadId || turnCount % FILE_INSTRUCTIONS_EVERY === 0;
  if (migrated) {
    persistThreads().catch((err) => console.warn('Failed to persist migrated threads:', err));
  }
  let promptWithContext = prompt;
  if (agent.id === 'claude') {
    promptWithContext = prefixTextWithTimestamp(promptWithContext, {
      timeZone: DEFAULT_TIME_ZONE,
    });
  }
  if (!threadId) {
    const bootstrap = await buildBootstrapContext({ threadKey });
    promptWithContext = promptWithContext
      ? `${bootstrap}\n\n${promptWithContext}`
      : bootstrap;
  }
  const retrievalContext = await buildMemoryRetrievalContext({
    query: prompt,
    chatId,
    topicId,
    agentId: effectiveAgentId,
    limit: MEMORY_RETRIEVAL_LIMIT,
  });
  if (retrievalContext) {
    promptWithContext = promptWithContext
      ? `${promptWithContext}\n\n${retrievalContext}`
      : retrievalContext;
  }
  const thinking = globalThinking;
  const finalPrompt = buildPrompt(
    promptWithContext,
    options.imagePaths || [],
    IMAGE_DIR,
    options.scriptContext,
    options.documentPaths || [],
    DOCUMENT_DIR,
    { includeFileInstructions: shouldIncludeFileInstructions }
  );
  const promptBase64 = Buffer.from(finalPrompt, 'utf8').toString('base64');
  const promptExpression = '"$PROMPT"';
  const agentCmd = agent.buildCommand({
    prompt: finalPrompt,
    promptExpression,
    threadId,
    thinking,
    model: globalModels[effectiveAgentId],
  });
  const command = [
    `PROMPT_B64=${shellQuote(promptBase64)};`,
    'PROMPT=$(printf %s "$PROMPT_B64" | base64 --decode);',
    `${agentCmd}`,
  ].join(' ');
  let commandToRun = command;
  if (agent.needsPty) {
    commandToRun = wrapCommandWithPty(commandToRun);
  }
  if (agent.mergeStderr) {
    commandToRun = `${commandToRun} 2>&1`;
  }

  const startedAt = Date.now();
  console.info(
    `Agent start chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} thread=${threadId || 'new'}`
  );
  let output;
  let execError;
  try {
    output = await execLocal('bash', ['-lc', commandToRun], {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: AGENT_MAX_BUFFER,
    });
  } catch (err) {
    execError = err;
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
      output = err.stdout;
    } else {
      throw err;
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    console.info(`Agent finished chat=${chatId} topic=${topicId || 'root'} durationMs=${elapsedMs}`);
  }
  const parsed = agent.parseOutput(output);
  if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
    throw execError;
  }
  if (execError) {
    console.warn(
      `Agent exited non-zero; returning stdout chat=${chatId} topic=${topicId || 'root'} code=${execError.code || 'unknown'}`
    );
  }
  if (!parsed.threadId && typeof agent.listSessionsCommand === 'function') {
    try {
      const listCommand = agent.listSessionsCommand();
      let listCommandToRun = listCommand;
      if (agent.needsPty) {
        listCommandToRun = wrapCommandWithPty(listCommandToRun);
      }
      if (agent.mergeStderr) {
        listCommandToRun = `${listCommandToRun} 2>&1`;
      }
      const listOutput = await execLocal('bash', ['-lc', listCommandToRun], {
        timeout: AGENT_TIMEOUT_MS,
        maxBuffer: AGENT_MAX_BUFFER,
      });
      if (typeof agent.parseSessionList === 'function') {
        const resolved = agent.parseSessionList(listOutput);
        if (resolved) {
          parsed.threadId = resolved;
        }
      }
    } catch (err) {
      console.warn('Failed to resolve agent session id:', err?.message || err);
    }
  }
  if (parsed.threadId) {
    threads.set(threadKey, parsed.threadId);
    persistThreads().catch((err) => console.warn('Failed to persist threads:', err));
  }
  return parsed.text || output;
}

async function replyWithResponse(ctx, response) {
  const { cleanedText: afterImages, imagePaths } = extractImageTokens(
    response || '',
    IMAGE_DIR
  );
  const { cleanedText, documentPaths } = extractDocumentTokens(
    afterImages,
    DOCUMENT_DIR
  );
  const text = cleanedText.trim();
  if (text) {
    for (const chunk of chunkMarkdown(text, 3000)) {
      const formatted = markdownToTelegramHtml(chunk) || chunk;
      await ctx.reply(formatted, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }
  const uniqueImages = Array.from(new Set(imagePaths));
  for (const imagePath of uniqueImages) {
    try {
      if (!isPathInside(IMAGE_DIR, imagePath)) {
        console.warn('Skipping image outside IMAGE_DIR:', imagePath);
        continue;
      }
      await fs.access(imagePath);
      await ctx.replyWithPhoto({ source: imagePath });
    } catch (err) {
      console.warn('Failed to send image:', imagePath, err);
    }
  }
  const uniqueDocuments = Array.from(new Set(documentPaths));
  for (const documentPath of uniqueDocuments) {
    try {
      if (!isPathInside(DOCUMENT_DIR, documentPath)) {
        console.warn('Skipping document outside DOCUMENT_DIR:', documentPath);
        continue;
      }
      await fs.access(documentPath);
      await ctx.replyWithDocument({ source: documentPath });
    } catch (err) {
      console.warn('Failed to send document:', documentPath, err);
    }
  }
  if (!text && uniqueImages.length === 0 && uniqueDocuments.length === 0) {
    await ctx.reply('(no response)');
  }
}

async function replyWithTranscript(ctx, transcript, replyToMessageId) {
  const header = 'Transcript:';
  const text = String(transcript || '').trim();
  const replyOptions = replyToMessageId ? { reply_to_message_id: replyToMessageId } : undefined;
  if (!text) {
    await ctx.reply(`${header}\n(vacía)`, replyOptions);
    return;
  }
  const maxChunkSize = Math.max(1, 3500 - header.length - 1);
  const chunks = chunkText(text, maxChunkSize);
  for (let i = 0; i < chunks.length; i += 1) {
    const prefix = i === 0 ? `${header}\n` : '';
    await ctx.reply(`${prefix}${chunks[i]}`, replyOptions);
  }
}

bot.start((ctx) => ctx.reply(`Ready. Send a message and I will pass it to ${getAgentLabel(globalAgent)}.`));

bot.command('thinking', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  if (!value) {
    if (globalThinking) {
      ctx.reply(`Current reasoning effort: ${globalThinking}`);
    } else {
      ctx.reply('No reasoning effort set. Use /thinking <level>.');
    }
    return;
  }
  try {
    globalThinking = value;
    ctx.reply(`Reasoning effort set to ${value}.`);
  } catch (err) {
    console.error(err);
    await replyWithError(ctx, 'Failed to update reasoning effort.', err);
  }
});

bot.command('agent', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  const topicId = getTopicId(ctx);
  const normalizedTopic = normalizeTopicId(topicId);

  if (!value) {
    const effective =
      getAgentOverride(agentOverrides, ctx.chat.id, topicId) || globalAgent;
    ctx.reply(
      `Current agent (${normalizedTopic}): ${getAgentLabel(
        effective,
      )}. Use /agent <name> or /agent default.`,
    );
    return;
  }

  if (value === 'default') {
    if (normalizedTopic === 'root') {
      ctx.reply('Already using global agent in root topic.');
      return;
    }
    clearAgentOverride(agentOverrides, ctx.chat.id, topicId);
    persistAgentOverrides().catch((err) =>
      console.warn('Failed to persist agent overrides:', err),
    );
    ctx.reply(
      `Agent override cleared for ${normalizedTopic}. Now using ${getAgentLabel(
        globalAgent,
      )}.`,
    );
    return;
  }

  if (!isKnownAgent(value)) {
    ctx.reply('Unknown agent. Use /agent codex|claude|gemini|opencode.');
    return;
  }

  const normalizedAgent = normalizeAgent(value);
  if (normalizedTopic === 'root') {
    globalAgent = normalizedAgent;
    try {
      await updateConfig({ agent: normalizedAgent });
      ctx.reply(`Global agent set to ${getAgentLabel(globalAgent)}.`);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to persist global agent setting.', err);
    }
  } else {
    setAgentOverride(agentOverrides, ctx.chat.id, topicId, normalizedAgent);
    persistAgentOverrides().catch((err) =>
      console.warn('Failed to persist agent overrides:', err),
    );
    ctx.reply(`Agent for this topic set to ${getAgentLabel(normalizedAgent)}.`);
  }
});

bot.command('reset', async (ctx) => {
  const topicId = getTopicId(ctx);
  const effectiveAgentId =
    getAgentOverride(agentOverrides, ctx.chat.id, topicId) || globalAgent;
  clearThreadForAgent(threads, ctx.chat.id, topicId, effectiveAgentId);
  threadTurns.delete(`${buildTopicKey(ctx.chat.id, topicId)}:${effectiveAgentId}`);
  persistThreads().catch((err) =>
    console.warn('Failed to persist threads after reset:', err),
  );
  try {
    await persistMemory(() => curateMemory());
    memoryEventsSinceCurate = 0;
    await ctx.reply(
      `Session reset for ${getAgentLabel(
        effectiveAgentId
      )} in this topic. Memory curated.`,
    );
  } catch (err) {
    console.warn('Failed to curate memory on reset:', err);
    await ctx.reply(
      `Session reset for ${getAgentLabel(
        effectiveAgentId
      )} in this topic. Memory curation failed.`,
    );
  }
});

bot.command('model', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  const agent = getAgent(globalAgent);

  if (!value) {
    const current = globalModels[globalAgent] || agent.defaultModel || '(default)';
    let msg = `Current model for ${agent.label}: ${current}. Use /model <model_id> to change or /model reset to clear.`;

    // Try to list available models if the agent supports it
    if (typeof agent.listModelsCommand === 'function') {
      const stopTyping = startTyping(ctx);
      try {
        const cmd = agent.listModelsCommand();
        let cmdToRun = cmd;
        if (agent.needsPty) cmdToRun = wrapCommandWithPty(cmdToRun);

        const output = await execLocal('bash', ['-lc', cmdToRun], { timeout: 30000 }); // Short timeout for listing

        // Use agent-specific parser if available, otherwise just dump output
        let modelsList = output.trim();
        if (typeof agent.parseModelList === 'function') {
          modelsList = agent.parseModelList(modelsList);
        }

        if (modelsList) {
          msg += `\n\nAvailable models:\n${modelsList}`;
        }
        stopTyping();
      } catch (err) {
        msg += `\n(Failed to list models: ${err.message})`;
        stopTyping();
      }
    }

    ctx.reply(msg);
    return;
  }

  try {
    if (isModelResetCommand(value)) {
      const { nextModels, hadOverride } = clearModelOverride(globalModels, globalAgent);
      globalModels = nextModels;
      await updateConfig({ models: globalModels });
      if (hadOverride) {
        const current = agent.defaultModel || '(default)';
        ctx.reply(`Model for ${agent.label} reset. Now using ${current}.`);
      } else {
        ctx.reply(`No model override set for ${agent.label}.`);
      }
      return;
    }

    globalModels[globalAgent] = value;
    await updateConfig({ models: globalModels });

    ctx.reply(`Model for ${agent.label} set to ${value}.`);
  } catch (err) {
    console.error(err);
    await replyWithError(ctx, 'Failed to persist model setting.', err);
  }
});

bot.command('cron', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  const parts = value ? value.split(/\s+/) : [];
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || subcommand === 'list') {
    try {
      const jobs = await loadCronJobs();
      if (jobs.length === 0) {
        await ctx.reply('No cron jobs configured.');
        return;
      }
      const lines = jobs.map((j) => {
        const status = j.enabled ? '✅' : '❌';
        const topicLabel = j.topicId ? ` [📌 Topic ${j.topicId}]` : '';
        return `${status} ${j.id}: ${j.cron}${topicLabel}`;
      });
      await ctx.reply(`Cron jobs:\n${lines.join('\n')}`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to list cron jobs.', err);
    }
    return;
  }

  if (subcommand === 'assign') {
    const jobId = parts[1];
    if (!jobId) {
      await ctx.reply('Usage: /cron assign <jobId>');
      return;
    }
    const topicId = getTopicId(ctx);
    if (!topicId) {
      await ctx.reply('Send this command from a topic/thread in a group to assign the cron to it.');
      return;
    }
    try {
      const jobs = await loadCronJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        await ctx.reply(`Cron job "${jobId}" not found. Available: ${jobs.map((j) => j.id).join(', ')}`);
        return;
      }
      job.topicId = topicId;
      job.chatId = ctx.chat.id;
      await saveCronJobs(jobs);
      if (cronScheduler) await cronScheduler.reload();
      await ctx.reply(`Cron "${jobId}" assigned to this topic (${topicId}).`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to assign cron job.', err);
    }
    return;
  }

  if (subcommand === 'unassign') {
    const jobId = parts[1];
    if (!jobId) {
      await ctx.reply('Usage: /cron unassign <jobId>');
      return;
    }
    try {
      const jobs = await loadCronJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        await ctx.reply(`Cron job "${jobId}" not found.`);
        return;
      }
      delete job.topicId;
      delete job.chatId;
      await saveCronJobs(jobs);
      if (cronScheduler) await cronScheduler.reload();
      await ctx.reply(`Cron "${jobId}" unassigned. Will send to default chat.`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to unassign cron job.', err);
    }
    return;
  }

  if (subcommand === 'run') {
    const jobId = parts[1];
    if (!jobId) {
      await ctx.reply('Usage: /cron run <jobId>');
      return;
    }
    try {
      const jobs = await loadCronJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        await ctx.reply(`Cron job "${jobId}" not found. Available: ${jobs.map((j) => j.id).join(', ')}`);
        return;
      }
      const payload = buildCronTriggerPayload(job, cronDefaultChatId || ctx.chat.id);
      const topicLabel = payload.options.topicId ? ` topic ${payload.options.topicId}` : '';
      const disabledLabel = job.enabled ? '' : ' (disabled in schedule, manual run forced)';
      await ctx.reply(`Running cron "${job.id}" now -> chat ${payload.chatId}${topicLabel}${disabledLabel}`);
      await handleCronTrigger(payload.chatId, payload.prompt, payload.options);
      await ctx.reply(`Cron "${job.id}" finished.`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to run cron job.', err);
    }
    return;
  }

  if (subcommand === 'reload') {
    if (cronScheduler) {
      const count = await cronScheduler.reload();
      await ctx.reply(`Cron jobs reloaded. ${count} job(s) scheduled.`);
    } else {
      await ctx.reply('Cron scheduler not running. Set cronChatId in config.json first.');
    }
    return;
  }

  if (subcommand === 'chatid') {
    await ctx.reply(`Your chat ID: ${ctx.chat.id}`);
    return;
  }

  await ctx.reply('Usage: /cron [list|reload|chatid|assign|unassign|run]');
});

bot.command('memory', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  const parts = value ? value.split(/\s+/).filter(Boolean) : [];
  const subcommand = (parts[0] || 'status').toLowerCase();
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
  const threadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);

  if (subcommand === 'status') {
    try {
      const status = await getMemoryStatus();
      const lines = [
        `Memory file: ${status.memoryPath}`,
        `Thread files: ${status.threadFiles}`,
        `Total events: ${status.totalEvents}`,
        `Indexed events: ${status.indexedEvents}`,
        `Index path: ${status.indexPath || '(unavailable)'}`,
        `FTS enabled: ${status.indexSupportsFts ? 'yes' : 'no'}`,
        `Events today: ${status.eventsToday}`,
        `Last curated: ${status.lastCuratedAt || '(never)'}`,
      ];
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      await replyWithError(ctx, 'Failed to read memory status.', err);
    }
    return;
  }

  if (subcommand === 'tail') {
    const parsed = Number(parts[1] || 10);
    const limit = Number.isFinite(parsed)
      ? Math.max(1, Math.min(50, Math.trunc(parsed)))
      : 10;
    try {
      const events = await getThreadTail(threadKey, { limit });
      if (!events.length) {
        await ctx.reply('No memory events in this conversation yet.');
        return;
      }
      const lines = events.map((event) => {
        const ts = String(event.createdAt || '').replace('T', ' ').slice(0, 16);
        const who = event.role === 'assistant' ? 'assistant' : 'user';
        const text = String(event.text || '').replace(/\s+/g, ' ').trim();
        return `- [${ts}] ${who}: ${text}`;
      });
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      await replyWithError(ctx, 'Failed to read thread memory tail.', err);
    }
    return;
  }

  if (subcommand === 'search') {
    const query = parts.slice(1).join(' ').trim();
    if (!query) {
      await ctx.reply('Usage: /memory search <query>');
      return;
    }
    const parsedLimit = Number(parts[parts.length - 1]);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(20, Math.trunc(parsedLimit)))
      : MEMORY_RETRIEVAL_LIMIT;
    try {
      const hits = await searchMemory({
        query,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        limit,
      });
      if (!hits.length) {
        await ctx.reply('No relevant memory found for that query.');
        return;
      }
      const lines = hits.map((hit) => {
        const ts = String(hit.createdAt || '').replace('T', ' ').slice(0, 16);
        const who = hit.role === 'assistant' ? 'assistant' : 'user';
        const text = String(hit.text || '').replace(/\s+/g, ' ').trim();
        const score = Number(hit.score || 0).toFixed(2);
        return `- [${ts}] (${hit.scope}, ${who}, score=${score}) ${text}`;
      });
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      await replyWithError(ctx, 'Memory search failed.', err);
    }
    return;
  }

  if (subcommand === 'curate') {
    enqueue(`${topicKey}:memory-curate`, async () => {
      const stopTyping = startTyping(ctx);
      try {
        const result = await persistMemory(() => curateMemory());
        memoryEventsSinceCurate = 0;
        await ctx.reply(
          [
            `Memory curated.`,
            `Events processed: ${result.eventsProcessed}`,
            `Thread files: ${result.threadFiles}`,
            `Output bytes: ${result.bytes}`,
            `Updated: ${result.lastCuratedAt}`,
          ].join('\n')
        );
      } catch (err) {
        await replyWithError(ctx, 'Memory curation failed.', err);
      } finally {
        stopTyping();
      }
    });
    return;
  }

  await ctx.reply('Usage: /memory [status|tail [n]|search <query>|curate]');
});

bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const text = ctx.message.text.trim();
  if (!text) return;

  const slash = parseSlashCommand(text);
  if (slash) {
    const normalized = slash.name.toLowerCase();
    if (
      [
        'start',
        'thinking',
        'agent',
        'model',
        'memory',
        'reset',
        'cron',
        'help',
        'document_scripts',
      ].includes(normalized)
    ) {
      return;
    }
    enqueue(topicKey, async () => {
      const stopTyping = startTyping(ctx);
      const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
      const memoryThreadKey = buildMemoryThreadKey(
        chatId,
        topicId,
        effectiveAgentId
      );
      try {
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'command',
          text,
        });
        let scriptMeta = {};
        try {
          scriptMeta = await scriptManager.getScriptMetadata(slash.name);
        } catch (err) {
          console.error('Failed to read script metadata', err);
          scriptMeta = {};
        }
        const output = await runScriptCommand(slash.name, slash.args);
        const llmPrompt =
          typeof scriptMeta?.llm?.prompt === 'string' ? scriptMeta.llm.prompt.trim() : '';
        if (llmPrompt) {
          const scriptContext = formatScriptContext({
            name: slash.name,
            output,
          });
          const response = await runAgentForChat(chatId, llmPrompt, {
            topicId,
            scriptContext,
          });
          await captureMemoryEvent({
            threadKey: memoryThreadKey,
            chatId,
            topicId,
            agentId: effectiveAgentId,
            role: 'assistant',
            kind: 'text',
            text: extractMemoryText(response),
          });
          stopTyping();
          await replyWithResponse(ctx, response);
          return;
        }
        lastScriptOutputs.set(topicKey, { name: slash.name, output });
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'assistant',
          kind: 'text',
          text: extractMemoryText(output),
        });
        stopTyping();
        await replyWithResponse(ctx, output);
      } catch (err) {
        console.error(err);
        stopTyping();
        await replyWithError(ctx, `Error running /${slash.name}.`, err);
      }
    });
    return;
  }

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    try {
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'text',
        text,
      });
      const scriptContext = consumeScriptContext(topicKey);
      const response = await runAgentForChat(chatId, text, {
        topicId,
        scriptContext,
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      stopTyping();
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      stopTyping();
      await replyWithError(ctx, 'Error processing response.', err);
    }
  });
});

bot.on(['voice', 'audio', 'document'], (ctx, next) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const payload = getAudioPayload(ctx.message);
  if (!payload) return next();

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let audioPath;
    let transcriptPath;
    try {
      audioPath = await downloadTelegramFile(ctx, payload, {
        prefix: 'audio',
        errorLabel: 'audio',
      });
      const { text, outputPath } = await transcribeAudio(audioPath);
      transcriptPath = outputPath;
      await replyWithTranscript(ctx, text, ctx.message?.message_id);
      if (!text) {
        await ctx.reply("I couldn't transcribe the audio.");
        return;
      }
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'audio',
        text,
      });
      const response = await runAgentForChat(chatId, text, { topicId });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      if (err && err.code === 'ENOENT') {
        await replyWithError(
          ctx,
          "I can't find parakeet-mlx. Install it and try again.",
          err,
        );
      } else {
        await replyWithError(ctx, 'Error processing audio.', err);
      }
    } finally {
      stopTyping();
      await safeUnlink(audioPath);
      await safeUnlink(transcriptPath);
    }
  });
});

bot.on(['photo', 'document'], (ctx, next) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const payload = getImagePayload(ctx.message);
  if (!payload) return next();

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let imagePath;
    try {
      imagePath = await downloadTelegramFile(ctx, payload, {
        dir: IMAGE_DIR,
        prefix: 'image',
        errorLabel: 'image',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent an image.';
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'image',
        text: prompt,
      });
      const response = await runAgentForChat(chatId, prompt, {
        topicId,
        imagePaths: [imagePath],
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Error processing image.', err);
    } finally {
      stopTyping();
    }
  });
});

bot.on('document', (ctx) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  if (getAudioPayload(ctx.message) || getImagePayload(ctx.message)) return;
  const payload = getDocumentPayload(ctx.message);
  if (!payload) return;

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let documentPath;
    try {
      documentPath = await downloadTelegramFile(ctx, payload, {
        dir: DOCUMENT_DIR,
        prefix: 'document',
        errorLabel: 'document',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent a document.';
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'document',
        text: prompt,
      });
      const response = await runAgentForChat(chatId, prompt, {
        topicId,
        documentPaths: [documentPath],
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Error processing document.', err);
    } finally {
      stopTyping();
    }
  });
});

async function sendResponseToChat(chatId, response, options = {}) {
  const { topicId } = options;
  const threadExtra = topicId ? { message_thread_id: topicId } : {};
  const { cleanedText: afterImages, imagePaths } = extractImageTokens(
    response || '',
    IMAGE_DIR
  );
  const { cleanedText, documentPaths } = extractDocumentTokens(
    afterImages,
    DOCUMENT_DIR
  );
  const text = cleanedText.trim();
  if (text) {
    for (const chunk of chunkMarkdown(text, 3000)) {
      const formatted = markdownToTelegramHtml(chunk) || chunk;
      await bot.telegram.sendMessage(chatId, formatted, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...threadExtra,
      });
    }
  }
  const uniqueImages = Array.from(new Set(imagePaths));
  for (const imagePath of uniqueImages) {
    try {
      if (!isPathInside(IMAGE_DIR, imagePath)) continue;
      await fs.access(imagePath);
      await bot.telegram.sendPhoto(chatId, { source: imagePath }, threadExtra);
    } catch (err) {
      console.warn('Failed to send image:', imagePath, err);
    }
  }
  const uniqueDocuments = Array.from(new Set(documentPaths));
  for (const documentPath of uniqueDocuments) {
    try {
      if (!isPathInside(DOCUMENT_DIR, documentPath)) continue;
      await fs.access(documentPath);
      await bot.telegram.sendDocument(chatId, { source: documentPath }, threadExtra);
    } catch (err) {
      console.warn('Failed to send document:', documentPath, err);
    }
  }
}

async function handleCronTrigger(chatId, prompt, options = {}) {
  const { jobId, agent, topicId } = options;
  const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId, agent);
  const memoryThreadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);
  console.info(`Cron job ${jobId} executing for chat ${chatId} topic=${topicId || 'none'}${agent ? ` (agent: ${agent})` : ''}`);
  try {
    const actionExtra = topicId ? { message_thread_id: topicId } : {};
    await bot.telegram.sendChatAction(chatId, 'typing', actionExtra);
    await captureMemoryEvent({
      threadKey: memoryThreadKey,
      chatId,
      topicId,
      agentId: effectiveAgentId,
      role: 'user',
      kind: 'cron',
      text: String(prompt || ''),
    });
    const response = await runAgentForChat(chatId, prompt, { agentId: agent, topicId });
    await captureMemoryEvent({
      threadKey: memoryThreadKey,
      chatId,
      topicId,
      agentId: effectiveAgentId,
      role: 'assistant',
      kind: 'text',
      text: extractMemoryText(response),
    });
    const silentTokens = ['HEARTBEAT_OK', 'CURATION_EMPTY'];
    const matchedToken = silentTokens.find(t => response.includes(t));
    if (matchedToken) {
      console.info(`Cron job ${jobId}: ${matchedToken} (silent)`);
      return;
    }
    await sendResponseToChat(chatId, response, { topicId });
  } catch (err) {
    console.error(`Cron job ${jobId} failed:`, err);
    try {
      const errExtra = topicId ? { message_thread_id: topicId } : {};
      await bot.telegram.sendMessage(chatId, `Cron job "${jobId}" failed: ${err.message}`, errExtra);
    } catch {}
  }
}

startImageCleanup();
startDocumentCleanup();
loadThreads()
  .then((loaded) => {
    threads = loaded;
    console.info(`Loaded ${threads.size} thread(s) from disk`);
  })
  .catch((err) => console.warn('Failed to load threads:', err));
loadAgentOverrides()
  .then((loaded) => {
    agentOverrides = loaded;
    console.info(`Loaded ${agentOverrides.size} agent override(s) from disk`);
  })
  .catch((err) => console.warn('Failed to load agent overrides:', err));
hydrateGlobalSettings()
  .then((config) => {
    cronDefaultChatId = config.cronChatId || null;
    if (cronDefaultChatId) {
      cronScheduler = startCronScheduler({
        chatId: cronDefaultChatId,
        onTrigger: handleCronTrigger,
      });
    } else {
      console.info('Cron scheduler disabled (no cronChatId in config)');
    }
  })
  .catch((err) => console.warn('Failed to load config settings:', err));
bot.launch();

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info(`Shutting down (${signal})...`);

  try {
    if (cronScheduler && typeof cronScheduler.stop === 'function') {
      cronScheduler.stop();
    }
  } catch (err) {
    console.warn('Failed to stop cron scheduler:', err);
  }

  try {
    bot.stop(signal);
  } catch (err) {
    console.warn('Failed to stop bot:', err);
  }

  const forceTimer = setTimeout(() => {
    console.warn('Forcing process exit after shutdown timeout.');
    process.exit(0);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS + 2000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  Promise.resolve()
    .then(async () => {
      const pending = Array.from(queues.values());
      if (pending.length > 0) {
        console.info(`Waiting for ${pending.length} queued job(s) to finish...`);
        await Promise.race([
          Promise.allSettled(pending),
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
        ]);
      }
      await Promise.race([
        Promise.allSettled([threadsPersist, agentOverridesPersist, memoryPersist]),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    })
    .catch((err) => {
      console.warn('Error during shutdown drain:', err);
    })
    .finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

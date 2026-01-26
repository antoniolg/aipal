require('dotenv').config();

const { Telegraf } = require('telegraf');
const { execFile } = require('child_process');
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
  loadThreads,
  readConfig,
  readMemory,
  readSoul,
  saveThreads,
  updateConfig,
} = require('./config-store');
const {
  CRON_PATH,
  loadCronJobs,
  saveCronJobs,
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
  createAccessControlMiddleware,
  parseAllowedUsersEnv,
} = require('./access-control');

const { ScriptManager } = require('./script-manager');

function formatLogTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function installLogTimestamps() {
  const levels = ['log', 'info', 'warn', 'error'];
  const original = {};
  for (const level of levels) {
    original[level] = console[level].bind(console);
  }
  for (const level of levels) {
    console[level] = (...args) => {
      original[level](`[${formatLogTimestamp()}]`, ...args);
    };
  }
}

installLogTimestamps();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}


const PARAKEET_CMD = 'parakeet-mlx';
const PARAKEET_TIMEOUT_MS = 120000;

const IMAGE_DIR = path.resolve(path.join(os.tmpdir(), 'aipal', 'images'));
const IMAGE_TTL_HOURS = 24;
const IMAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const DOCUMENT_DIR = path.resolve(path.join(os.tmpdir(), 'aipal', 'documents'));
const DOCUMENT_TTL_HOURS = 24;
const DOCUMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const SCRIPTS_DIR =
  process.env.AIPAL_SCRIPTS_DIR ||
  path.join(os.homedir(), '.config', 'aipal', 'scripts');
const SCRIPT_TIMEOUT_MS = readNumberEnv(
  process.env.AIPAL_SCRIPT_TIMEOUT_MS,
  120000
);
const AGENT_TIMEOUT_MS = readNumberEnv(
  process.env.AIPAL_AGENT_TIMEOUT_MS,
  600000
);
const AGENT_MAX_BUFFER = readNumberEnv(
  process.env.AIPAL_AGENT_MAX_BUFFER,
  10 * 1024 * 1024
);
const SCRIPT_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

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

const queues = new Map();
let threads = new Map();
let threadsPersist = Promise.resolve();
const lastScriptOutputs = new Map();
const SCRIPT_CONTEXT_MAX_CHARS = 8000;
let globalThinking;
let globalAgent = AGENT_CODEX;
let globalModels = {};

const scriptManager = new ScriptManager(SCRIPTS_DIR);

bot.command('help', async (ctx) => {
  const builtIn = [
    '/start - Hello world',
    '/agent <name> - Switch agent (codex, claude, gemini, opencode)',
    '/thinking <level> - Set reasoning effort',
    '/model [model_id] - View/set model for current agent',
    '/reset - Reset session',
    '/cron [list|reload|chatid] - Manage cron jobs',
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
    const desc = s.description ? ` - ${s.description}` : '';
    return `- /${s.name}${desc}`;
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

function readNumberEnv(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function getThreadKey(chatId) {
  return String(chatId);
}

function persistThreads() {
  threadsPersist = threadsPersist
    .catch(() => {})
    .then(() => saveThreads(threads));
  return threadsPersist;
}

async function buildBootstrapContext() {
  const soul = await readSoul();
  const memory = await readMemory();
  const lines = [
    'Bootstrap config:',
    `Config JSON: ${CONFIG_PATH}`,
    `Soul file: ${SOUL_PATH}`,
    `Memory file: ${MEMORY_PATH}`,
  ];
  if (soul.exists && soul.content) {
    lines.push('Soul (soul.md):');
    lines.push(soul.content);
    lines.push('End of soul.');
  }
  if (memory.exists && memory.content) {
    lines.push('Memory (memory.md):');
    lines.push(memory.content);
    lines.push('End of memory.');
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

function shellQuote(value) {
  const escaped = String(value).replace(/'/g, String.raw`'\''`);
  return `'${escaped}'`;
}

function wrapCommandWithPty(command) {
  const python = 'import pty,sys; pty.spawn(["bash","-lc", sys.argv[1]])';
  return `python3 -c ${shellQuote(python)} ${shellQuote(command)}`;
}

function execLocal(cmd, args, options = {}) {
  const { timeout, maxBuffer, ...rest } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer, ...rest }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        if (timeout && err.killed) {
          const timeoutErr = new Error(`Command timed out after ${timeout}ms`);
          timeoutErr.code = 'ETIMEDOUT';
          timeoutErr.stderr = stderr;
          timeoutErr.stdout = stdout;
          return reject(timeoutErr);
        }
        return reject(err);
      }
      resolve(stdout || '');
    });
  });
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

function consumeScriptContext(chatId) {
  const entry = lastScriptOutputs.get(chatId);
  if (!entry) return '';
  lastScriptOutputs.delete(chatId);
  return formatScriptContext(entry);
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

async function transcribeWithParakeet(audioPath) {
  const outputDir = path.join(os.tmpdir(), 'parakeet-mlx');
  await fs.mkdir(outputDir, { recursive: true });
  const outputTemplate = `parakeet-${randomUUID()}`;
  const args = [
    audioPath,
    '--output-dir',
    outputDir,
    '--output-format',
    'txt',
    '--output-template',
    outputTemplate,
  ];
  await execLocal(PARAKEET_CMD, args, { timeout: PARAKEET_TIMEOUT_MS });
  const outputPath = path.join(outputDir, `${outputTemplate}.txt`);
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
  const promptText = String(prompt || '');
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
  const threadKey = getThreadKey(chatId);
  const threadId = threads.get(threadKey);
  const agent = getAgent(globalAgent);
  let promptWithContext = prompt;
  if (!threadId) {
    const bootstrap = await buildBootstrapContext();
    promptWithContext = promptWithContext
      ? `${bootstrap}\n\n${promptWithContext}`
      : bootstrap;
  }
  const thinking = globalThinking;
  const finalPrompt = buildPrompt(
    promptWithContext,
    options.imagePaths || [],
    IMAGE_DIR,
    options.scriptContext,
    options.documentPaths || [],
    DOCUMENT_DIR
  );
  const promptBase64 = Buffer.from(finalPrompt, 'utf8').toString('base64');
  const promptExpression = '"$PROMPT"';
  const agentCmd = agent.buildCommand({
    prompt: finalPrompt,
    promptExpression,
    threadId,
    thinking,
    model: globalModels[globalAgent],
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
  console.info(`Agent start chat=${chatId} thread=${threadId || 'new'}`);
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
    console.info(`Agent finished chat=${chatId} durationMs=${elapsedMs}`);
  }
  const parsed = agent.parseOutput(output);
  if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
    throw execError;
  }
  if (execError) {
    console.warn(
      `Agent exited non-zero; returning stdout chat=${chatId} code=${execError.code || 'unknown'}`
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
  if (parsed.sawJson) {
    return parsed.text || output;
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

function enqueue(chatId, fn) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    console.error('Queue error', err);
  });
  queues.set(chatId, next);
  return next;
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
  if (!value) {
    ctx.reply(`Current agent: ${getAgentLabel(globalAgent)}. Use /agent codex|claude|gemini|opencode.`);
    return;
  }
  if (!isKnownAgent(value)) {
    ctx.reply('Unknown agent. Use /agent codex|claude|gemini|opencode.');
    return;
  }
  const normalized = normalizeAgent(value);
  try {
    const changed = normalized !== globalAgent;
    globalAgent = normalized;
    await updateConfig({ agent: normalized });
    if (changed) {
      threads.clear();
      await persistThreads();
    }
    ctx.reply(`Agent set to ${getAgentLabel(globalAgent)}.`);
  } catch (err) {
    console.error(err);
    await replyWithError(ctx, 'Failed to persist agent setting.', err);
  }
});

bot.command('reset', async (ctx) => {
  threads.delete(getThreadKey(ctx.chat.id));
  persistThreads().catch((err) => console.warn('Failed to persist threads after reset:', err));
  ctx.reply('Session reset.');
});

bot.command('model', async (ctx) => {
  const value = extractCommandValue(ctx.message.text);
  const agent = getAgent(globalAgent);

  if (!value) {
    const current = globalModels[globalAgent] || agent.defaultModel || '(default)';
    let msg = `Current model for ${agent.label}: ${current}. Use /model <model_id> to change.`;

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
        return `${status} ${j.id}: ${j.cron} → "${j.prompt}"`;
      });
      await ctx.reply(`Cron jobs:\n${lines.join('\n')}`);
    } catch (err) {
      await replyWithError(ctx, 'Failed to list cron jobs.', err);
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

  await ctx.reply('Usage: /cron [list|reload|chatid]');
});

bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
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
        'reset',
        'cron',
        'help',
        'document_scripts',
      ].includes(normalized)
    ) {
      return;
    }
    enqueue(chatId, async () => {
      const stopTyping = startTyping(ctx);
      try {
        const output = await runScriptCommand(slash.name, slash.args);
        lastScriptOutputs.set(chatId, { name: slash.name, output });
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

  enqueue(chatId, async () => {
    const stopTyping = startTyping(ctx);
    try {
      const scriptContext = consumeScriptContext(chatId);
      const response = await runAgentForChat(chatId, text, { scriptContext });
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
  const payload = getAudioPayload(ctx.message);
  if (!payload) return next();

  enqueue(chatId, async () => {
    const stopTyping = startTyping(ctx);
    let audioPath;
    let transcriptPath;
    try {
      audioPath = await downloadTelegramFile(ctx, payload, {
        prefix: 'audio',
        errorLabel: 'audio',
      });
      const { text, outputPath } = await transcribeWithParakeet(audioPath);
      transcriptPath = outputPath;
      await replyWithTranscript(ctx, text, ctx.message?.message_id);
      if (!text) {
        await ctx.reply("I couldn't transcribe the audio.");
        return;
      }
      const response = await runAgentForChat(chatId, text);
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      if (err && err.code === 'ENOENT') {
        await replyWithError(
          ctx,
          "I can't find parakeet-mlx. Install it and try again.",
          err
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
  const payload = getImagePayload(ctx.message);
  if (!payload) return next();

  enqueue(chatId, async () => {
    const stopTyping = startTyping(ctx);
    let imagePath;
    try {
      imagePath = await downloadTelegramFile(ctx, payload, {
        dir: IMAGE_DIR,
        prefix: 'image',
        errorLabel: 'image',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent an image.';
      const response = await runAgentForChat(chatId, prompt, {
        imagePaths: [imagePath],
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
  if (getAudioPayload(ctx.message) || getImagePayload(ctx.message)) return;
  const payload = getDocumentPayload(ctx.message);
  if (!payload) return;

  enqueue(chatId, async () => {
    const stopTyping = startTyping(ctx);
    let documentPath;
    try {
      documentPath = await downloadTelegramFile(ctx, payload, {
        dir: DOCUMENT_DIR,
        prefix: 'document',
        errorLabel: 'document',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent a document.';
      const response = await runAgentForChat(chatId, prompt, {
        documentPaths: [documentPath],
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

async function sendResponseToChat(chatId, response) {
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
      });
    }
  }
  const uniqueImages = Array.from(new Set(imagePaths));
  for (const imagePath of uniqueImages) {
    try {
      if (!isPathInside(IMAGE_DIR, imagePath)) continue;
      await fs.access(imagePath);
      await bot.telegram.sendPhoto(chatId, { source: imagePath });
    } catch (err) {
      console.warn('Failed to send image:', imagePath, err);
    }
  }
  const uniqueDocuments = Array.from(new Set(documentPaths));
  for (const documentPath of uniqueDocuments) {
    try {
      if (!isPathInside(DOCUMENT_DIR, documentPath)) continue;
      await fs.access(documentPath);
      await bot.telegram.sendDocument(chatId, { source: documentPath });
    } catch (err) {
      console.warn('Failed to send document:', documentPath, err);
    }
  }
}

async function handleCronTrigger(chatId, prompt, options = {}) {
  const { jobId } = options;
  console.info(`Cron job ${jobId} executing for chat ${chatId}`);
  try {
    await bot.telegram.sendChatAction(chatId, 'typing');
    const response = await runAgentForChat(chatId, prompt);
    await sendResponseToChat(chatId, response);
  } catch (err) {
    console.error(`Cron job ${jobId} failed:`, err);
    try {
      await bot.telegram.sendMessage(chatId, `Cron job "${jobId}" failed: ${err.message}`);
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
hydrateGlobalSettings()
  .then((config) => {
    if (config.cronChatId) {
      cronScheduler = startCronScheduler({
        chatId: config.cronChatId,
        onTrigger: handleCronTrigger,
      });
    } else {
      console.info('Cron scheduler disabled (no cronChatId in config)');
    }
  })
  .catch((err) => console.warn('Failed to load config settings:', err));
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

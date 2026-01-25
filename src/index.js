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
  readConfig,
  readMemory,
  readSoul,
  updateConfig,
} = require('./config-store');
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
const queues = new Map();
const threads = new Map();
const lastScriptOutputs = new Map();
const SCRIPT_CONTEXT_MAX_CHARS = 8000;
let globalThinking;
let globalAgent = AGENT_CODEX;

bot.catch((err) => {
  console.error('Bot error', err);
});

function readNumberEnv(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
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

async function hydrateGlobalSettings() {
  const config = await readConfig();
  if (config.agent) globalAgent = normalizeAgent(config.agent);
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

async function runAgentForChat(chatId, prompt, options = {}) {
  const threadId = threads.get(chatId);
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
  try {
    output = await execLocal('bash', ['-lc', commandToRun], {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: AGENT_MAX_BUFFER,
    });
  } catch (err) {
    if (err.stdout) {
      output = err.stdout;
    } else {
      throw err;
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    console.info(`Agent finished chat=${chatId} durationMs=${elapsedMs}`);
  }
  const parsed = agent.parseOutput(output);
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
    threads.set(chatId, parsed.threadId);
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
    }
    ctx.reply(`Agent set to ${getAgentLabel(globalAgent)}.`);
  } catch (err) {
    console.error(err);
    await replyWithError(ctx, 'Failed to persist agent setting.', err);
  }
});

bot.command('reset', async (ctx) => {
  threads.delete(ctx.chat.id);
  ctx.reply('Session reset.');
});

bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  if (!text) return;

  const slash = parseSlashCommand(text);
  if (slash) {
    const normalized = slash.name.toLowerCase();
    if (['start', 'thinking', 'agent', 'reset'].includes(normalized)) return;
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

startImageCleanup();
startDocumentCleanup();
hydrateGlobalSettings().catch((err) => console.warn('Failed to load config settings:', err));
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

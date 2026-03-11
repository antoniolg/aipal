const { shellQuote, resolvePromptValue } = require('./utils');

const CODEX_CMD = 'codex';
const BASE_ARGS = '--json --skip-git-repo-check --yolo';
const MODEL_ARG = '--model';
const REASONING_CONFIG_KEY = 'model_reasoning_effort';

function appendOptionalArg(args, flag, value) {
  if (!flag || !value) return args;
  return `${args} ${flag} ${shellQuote(value)}`.trim();
}

function appendOptionalReasoning(args, value) {
  if (!value) return args;
  const configValue = `${REASONING_CONFIG_KEY}="${value}"`;
  return `${args} --config ${shellQuote(configValue)}`.trim();
}

function buildCommand({ prompt, promptExpression, threadId, model, thinking }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  let args = BASE_ARGS;
  args = appendOptionalArg(args, MODEL_ARG, model);
  args = appendOptionalReasoning(args, thinking);
  if (threadId) {
    return `${CODEX_CMD} exec resume ${shellQuote(threadId)} ${args} ${promptValue}`.trim();
  }
  return `${CODEX_CMD} exec ${args} ${promptValue}`.trim();
}

function collectMessages(output) {
  const lines = String(output || '').split(/\r?\n/);
  let threadId;
  const allMessages = [];
  const finalMessages = [];
  const commentaryMessages = [];
  let sawJson = false;
  let buffer = '';
  for (const line of lines) {
    if (!buffer) {
      if (!line.startsWith('{')) {
        continue;
      }
      buffer = line;
    } else {
      buffer += line;
    }
    let payload;
    try {
      payload = JSON.parse(buffer);
    } catch {
      continue;
    }
    sawJson = true;
    buffer = '';
    if (payload.type === 'thread.started' && payload.thread_id) {
      threadId = payload.thread_id;
      continue;
    }
    if (payload.type === 'item.completed' && payload.item && typeof payload.item.text === 'string') {
      const itemType = String(payload.item.type || '');
      if (itemType.includes('message')) {
        const text = String(payload.item.text || '');
        if (!text.trim()) continue;
        allMessages.push(text);
        const channel = String(
          payload.item.channel ||
            payload.item.message?.channel ||
            payload.item.metadata?.channel ||
            ''
        ).toLowerCase();
        if (channel === 'final') {
          finalMessages.push(text);
        } else if (channel === 'commentary') {
          commentaryMessages.push(text);
        }
      }
    }
  }
  return { threadId, allMessages, finalMessages, commentaryMessages, sawJson };
}

function parseOutput(output) {
  const { threadId, allMessages, finalMessages, sawJson } = collectMessages(output);
  const selected = finalMessages.length > 0 ? finalMessages : allMessages.slice(-1);
  const text = selected.join('\n').trim();
  return { text, threadId, sawJson };
}

function parseStreamingOutput(output) {
  const { threadId, finalMessages, commentaryMessages, sawJson } = collectMessages(output);
  const text = finalMessages.length > 0
    ? String(finalMessages[finalMessages.length - 1] || '').trim()
    : '';
  return {
    text,
    threadId,
    sawJson,
    sawFinal: finalMessages.length > 0,
    commentaryMessages,
  };
}

module.exports = {
  id: 'codex',
  label: 'codex',
  needsPty: false,
  mergeStderr: false,
  buildCommand,
  parseOutput,
  parseStreamingOutput,
};

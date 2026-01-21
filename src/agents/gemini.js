const { resolvePromptValue } = require('./utils');

const GEMINI_CMD = 'gemini';
const GEMINI_OUTPUT_FORMAT = 'json';
const SESSION_ID_REGEX = /\[([0-9a-f-]{16,})\]/i;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildCommand({ prompt, promptExpression, threadId }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const args = ['-p', promptValue, '--output-format', GEMINI_OUTPUT_FORMAT, '--yolo'];
  if (threadId) {
    args.push('--resume', threadId);
  }
  return `${GEMINI_CMD} ${args.join(' ')}`.trim();
}

function parseOutput(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed) return { text: '', threadId: undefined, sawJson: false };
  const payload = safeJsonParse(trimmed);
  if (!payload || typeof payload !== 'object') {
    return { text: trimmed, threadId: undefined, sawJson: false };
  }
  if (payload.error && payload.error.message) {
    return { text: String(payload.error.message), threadId: undefined, sawJson: true };
  }
  const response = typeof payload.response === 'string' ? payload.response.trim() : '';
  return { text: response, threadId: undefined, sawJson: true };
}

function listSessionsCommand() {
  return `${GEMINI_CMD} --list-sessions`;
}

function parseSessionList(output) {
  const lines = String(output || '').split(/\r?\n/);
  let lastId;
  for (const line of lines) {
    const match = line.match(SESSION_ID_REGEX);
    if (match) {
      lastId = match[1];
    }
  }
  return lastId;
}

module.exports = {
  id: 'gemini',
  label: 'gemini',
  needsPty: false,
  mergeStderr: false,
  buildCommand,
  parseOutput,
  listSessionsCommand,
  parseSessionList,
};

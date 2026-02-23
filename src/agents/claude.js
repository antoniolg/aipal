const { shellQuote, resolvePromptValue } = require('./utils');

const CLAUDE_CMD = 'claude';
const CLAUDE_OUTPUT_FORMAT = 'json';
const CLAUDE_SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
}

function sanitizeSessionId(value) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/^['"]+/, '')
    .replace(/['"\\]+$/, '')
    .trim();
  if (!CLAUDE_SESSION_ID_REGEX.test(cleaned)) return undefined;
  return cleaned;
}

function buildCommand({ prompt, promptExpression, threadId }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const args = [
    '-p',
    promptValue,
    '--output-format',
    CLAUDE_OUTPUT_FORMAT,
    '--dangerously-skip-permissions',
  ];
  const safeThreadId = sanitizeSessionId(threadId);
  if (safeThreadId) {
    args.push('--resume', shellQuote(safeThreadId));
  }
  return `${CLAUDE_CMD} ${args.join(' ')}`.trim();
}

function parseOutput(output) {
  const cleaned = stripAnsi(output);
  const trimmed = cleaned.trim();
  if (!trimmed) return { text: '', threadId: undefined, sawJson: false };
  let payload = safeJsonParse(trimmed);
  if (!payload) {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      payload = safeJsonParse(line.trim());
      if (payload) break;
    }
  }
  if (!payload || typeof payload !== 'object') {
    return { text: trimmed, threadId: undefined, sawJson: false };
  }
  const threadId = sanitizeSessionId(
    payload.session_id ||
      payload.sessionId ||
      payload.conversation_id ||
      payload.conversationId ||
      undefined
  );
  let text = payload.result;
  if (typeof text !== 'string') {
    text = payload.text;
  }
  if (typeof text !== 'string') {
    text = payload.output;
  }
  if (typeof text !== 'string' && payload.structured_output != null) {
    text = JSON.stringify(payload.structured_output, null, 2);
  }
  return { text: typeof text === 'string' ? text.trim() : '', threadId, sawJson: true };
}

module.exports = {
  id: 'claude',
  label: 'claude',
  needsPty: true,
  mergeStderr: false,
  buildCommand,
  parseOutput,
};

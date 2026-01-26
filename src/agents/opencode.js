const { shellQuote, resolvePromptValue } = require('./utils');

const OPENCODE_CMD = 'opencode';
const OPENCODE_PERMISSION = '{"*": "allow"}';
const OPENCODE_OUTPUT_FORMAT = 'json';
const DEFAULT_MODEL = 'opencode/gpt-5-nano';

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildCommand({ prompt, promptExpression, threadId, model }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const args = ['run', '--format', OPENCODE_OUTPUT_FORMAT];

  const modelToUse = model || DEFAULT_MODEL;
  args.push('--model', shellQuote(modelToUse));

  if (threadId) {
    args.push('--continue');
    args.push('--session', shellQuote(threadId));
  }

  // Prompt is last, as positional argument
  args.push(promptValue);

  const command = `${OPENCODE_CMD} ${args.join(' ')}`.trim();

  // Prepend permission env and append input redirection
  return `OPENCODE_PERMISSION=${shellQuote(OPENCODE_PERMISSION)} ${command} < /dev/null`;
}

function parseOutput(output) {
  const lines = String(output || '').split(/\r?\n/);
  let threadId;
  const textParts = [];
  let sawJson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip non-JSON lines (like INFO logs)
    if (!trimmed.startsWith('{')) continue;

    const payload = safeJsonParse(trimmed);
    if (!payload || typeof payload !== 'object') continue;

    sawJson = true;

    if (payload.sessionID) {
      threadId = payload.sessionID;
    }

    if (payload.type === 'text' && payload.part && payload.part.text) {
      textParts.push(payload.part.text);
    }
  }

  const text = textParts.join('').trim();

  if (!sawJson) {
    return {
      text: String(output || '').trim(),
      threadId: undefined,
      sawJson: false,
    };
  }

  return { text, threadId, sawJson: true };
}

function listModelsCommand() {
  // Prepend permission env and append input redirection
  return `OPENCODE_PERMISSION=${shellQuote(OPENCODE_PERMISSION)} ${OPENCODE_CMD} models < /dev/null`;
}

function parseModelList(output) {
  const lines = String(output || '').split(/\r?\n/);
  const models = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('INFO')) continue;
    models.push(trimmed);
  }
  return models.join('\n');
}

module.exports = {
  id: 'opencode',
  label: 'opencode',
  needsPty: false,
  mergeStderr: false,
  buildCommand,
  parseOutput,
  listModelsCommand,
  parseModelList,
  defaultModel: DEFAULT_MODEL,
};

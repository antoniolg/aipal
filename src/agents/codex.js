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

function extractTextFromMessagePayload(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;

  const content = Array.isArray(message.content) ? message.content : [];
  const textParts = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.output_text === 'string') return part.output_text;
      if (typeof part.input_text === 'string') return part.input_text;
      return '';
    })
    .filter(Boolean);

  return textParts.join('\n').trim();
}

function pushMessageByPhase({ text, phase, allMessages, finalMessages, commentaryMessages }) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return;

  allMessages.push(normalizedText);

  const normalizedPhase = String(phase || '').toLowerCase();
  if (normalizedPhase === 'final' || normalizedPhase === 'final_answer') {
    finalMessages.push(normalizedText);
  } else if (normalizedPhase === 'commentary') {
    commentaryMessages.push(normalizedText);
  }
}

function collectMessages(output) {
  const lines = String(output || '').split(/\r?\n/);
  let threadId;
  const allMessages = [];
  const finalMessages = [];
  const commentaryMessages = [];
  let sawJson = false;
  let sawTurnCompleted = false;
  let sawExplicitFinal = false;
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
    if (payload.type === 'turn.completed') {
      sawTurnCompleted = true;
      continue;
    }
    if (payload.type === 'item.completed' && payload.item && typeof payload.item.text === 'string') {
      const itemType = String(payload.item.type || '');
      if (itemType.includes('message')) {
        const channel = String(
          payload.item.channel ||
            payload.item.message?.channel ||
            payload.item.metadata?.channel ||
            ''
        ).toLowerCase();
        if (channel) {
          pushMessageByPhase({
            text: payload.item.text,
            phase: channel,
            allMessages,
            finalMessages,
            commentaryMessages,
          });
          if (channel === 'final') {
            sawExplicitFinal = true;
          }
        } else {
          const text = String(payload.item.text || '').trim();
          if (text) {
            allMessages.push(text);
          }
        }
      }
      continue;
    }

    if (payload.type === 'response_item' && payload.payload?.type === 'message') {
      if (String(payload.payload.phase || '').toLowerCase() === 'final_answer') {
        sawExplicitFinal = true;
      }
      pushMessageByPhase({
        text: extractTextFromMessagePayload(payload.payload),
        phase: payload.payload.phase,
        allMessages,
        finalMessages,
        commentaryMessages,
      });
      continue;
    }

    if (payload.type === 'event_msg' && payload.payload?.type === 'agent_message') {
      if (String(payload.payload.phase || '').toLowerCase() === 'final_answer') {
        sawExplicitFinal = true;
      }
      pushMessageByPhase({
        text: payload.payload.message,
        phase: payload.payload.phase,
        allMessages,
        finalMessages,
        commentaryMessages,
      });
    }
  }

  if (finalMessages.length === 0 && allMessages.length > 0) {
    if (sawTurnCompleted) {
      finalMessages.push(allMessages[allMessages.length - 1]);
      commentaryMessages.splice(0, commentaryMessages.length, ...allMessages.slice(0, -1));
    } else {
      commentaryMessages.splice(0, commentaryMessages.length, ...allMessages);
    }
  }

  return {
    threadId,
    allMessages,
    finalMessages,
    commentaryMessages,
    sawJson,
    sawTurnCompleted,
    sawExplicitFinal,
  };
}

function parseOutput(output) {
  const { threadId, allMessages, finalMessages, sawJson } = collectMessages(output);
  const selected = finalMessages.length > 0 ? finalMessages : allMessages.slice(-1);
  const text = selected.join('\n').trim();
  return { text, threadId, sawJson };
}

function parseStreamingOutput(output) {
  const {
    threadId,
    finalMessages,
    commentaryMessages,
    sawJson,
    sawTurnCompleted,
    sawExplicitFinal,
  } = collectMessages(output);
  const text = finalMessages.length > 0
    ? String(finalMessages[finalMessages.length - 1] || '').trim()
    : '';
  return {
    text,
    threadId,
    sawJson,
    sawFinal: sawExplicitFinal || (finalMessages.length > 0 && sawTurnCompleted),
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

const path = require('path');
const { existsSync, readFileSync } = require('fs');

const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const DEFAULT_CODEX_ARGS = CODEX_CMD === 'codex' ? '--json --skip-git-repo-check' : '';
const CODEX_ARGS = process.env.CODEX_ARGS || DEFAULT_CODEX_ARGS;
const CODEX_TEMPLATE = process.env.CODEX_TEMPLATE || '';

const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(process.cwd(), 'config.json');

function loadJsonConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to load config JSON:', err);
    return {};
  }
}

function normalizeAgentName(name) {
  return String(name || '').trim().toLowerCase();
}

function getAgentConfigByName(agents, agentName) {
  if (!agents || typeof agents !== 'object') return null;
  if (agents[agentName]) return agents[agentName];
  const entry = Object.entries(agents).find(([key]) => normalizeAgentName(key) === agentName);
  return entry ? entry[1] : null;
}

function mergeAgentConfig(baseConfig, overrideConfig) {
  if (!overrideConfig) return { ...baseConfig };
  const merged = { ...baseConfig, ...overrideConfig };
  if (baseConfig.session || overrideConfig.session) {
    merged.session = { ...(baseConfig.session || {}), ...(overrideConfig.session || {}) };
  }
  return merged;
}

function resolveAgentConfig() {
  const rawConfig = loadJsonConfig(CONFIG_PATH);
  const agentName = normalizeAgentName(rawConfig.agent || process.env.AGENT || 'codex');
  const agents = rawConfig.agents || {};

  const defaultAgents = {
    codex: {
      type: 'codex',
      cmd: CODEX_CMD,
      args: CODEX_ARGS,
      template: CODEX_TEMPLATE,
      output: 'codex-json',
      session: { strategy: 'thread' },
      label: 'codex',
      modelArg: '--model',
      thinkingArg: '--thinking',
    },
    'cloud-code': {
      type: 'generic',
      cmd: 'cloud-code',
      args: '',
      template: '',
      output: 'text',
      session: { strategy: 'chat' },
      label: 'cloud code',
    },
    'gemini-cly': {
      type: 'generic',
      cmd: 'gemini-cly',
      args: '',
      template: '',
      output: 'text',
      session: { strategy: 'chat' },
      label: 'gemini cly',
    },
  };

  const override = getAgentConfigByName(agents, agentName);
  const base = defaultAgents[agentName] || (override ? { type: 'generic', output: 'text' } : defaultAgents.codex);
  const agentConfig = mergeAgentConfig(base, override);
  return { agentName, agentConfig, configPath: CONFIG_PATH, hasConfig: existsSync(CONFIG_PATH) };
}

function shellQuote(value) {
  const escaped = String(value).replace(/'/g, String.raw`'\''`);
  return `'${escaped}'`;
}

function ensureJsonArgs(args) {
  const trimmed = args.trim();
  if (!trimmed) return '--json';
  if (trimmed.includes('--json')) return trimmed;
  return `${trimmed} --json`.trim();
}

function ensureSkipGitCheckArgs(args) {
  const trimmed = args.trim();
  if (!trimmed) return '--skip-git-repo-check';
  if (trimmed.includes('--skip-git-repo-check')) return trimmed;
  return `${trimmed} --skip-git-repo-check`.trim();
}

function normalizeExecArgs(args) {
  const trimmed = args.trim();
  if (trimmed === 'exec') return '';
  if (trimmed.startsWith('exec ')) return trimmed.slice('exec '.length);
  return trimmed;
}

function hasGitRepo() {
  return existsSync(path.join(process.cwd(), '.git'));
}

function resolveSessionValue(agentConfig, chatId, threadId) {
  const strategy = agentConfig.session && agentConfig.session.strategy;
  if (strategy === 'chat') return String(chatId);
  if (strategy === 'thread') return threadId || '';
  return '';
}

function buildFromTemplate(template, promptValue, sessionValue, modelValue, thinkingValue) {
  return template
    .split('{prompt}')
    .join(promptValue || '')
    .split('{session}')
    .join(sessionValue || '')
    .split('{model}')
    .join(modelValue || '')
    .split('{thinking}')
    .join(thinkingValue || '')
    .trim();
}

function resolvePromptValue(prompt, promptExpression) {
  if (promptExpression) return promptExpression;
  return shellQuote(prompt);
}

function appendOptionalArg(args, flag, value) {
  if (!flag || !value) return args;
  return `${args} ${flag} ${shellQuote(value)}`.trim();
}

function buildCodexCommand(
  prompt,
  threadId,
  agentConfig,
  sessionValue,
  promptExpression,
  modelValue,
  thinkingValue
) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const template = agentConfig.template || '';
  const cmd = agentConfig.cmd || 'codex';
  const argsRaw = agentConfig.args || '';
  const modelToken = modelValue ? shellQuote(modelValue) : '';
  const thinkingToken = thinkingValue ? shellQuote(thinkingValue) : '';

  if (template) {
    const hasPrompt = template.includes('{prompt}');
    const hasSession = template.includes('{session}');
    const hasModel = template.includes('{model}');
    const hasThinking = template.includes('{thinking}');
    const base =
      hasPrompt || hasSession || hasModel || hasThinking
        ? buildFromTemplate(template, promptValue, sessionValue, modelToken, thinkingToken)
        : template.trim();
    if (hasPrompt) {
      let command = base;
      if (!hasModel) {
        command = appendOptionalArg(command, agentConfig.modelArg, modelValue);
      }
      if (!hasThinking) {
        command = appendOptionalArg(command, agentConfig.thinkingArg, thinkingValue);
      }
      return command.trim();
    }
    let command = `${base} ${promptValue}`.trim();
    if (!hasModel) {
      command = appendOptionalArg(command, agentConfig.modelArg, modelValue);
    }
    if (!hasThinking) {
      command = appendOptionalArg(command, agentConfig.thinkingArg, thinkingValue);
    }
    return command.trim();
  }

  let args = normalizeExecArgs(argsRaw);
  args = ensureJsonArgs(args);
  args = appendOptionalArg(args, agentConfig.modelArg, modelValue);
  args = appendOptionalArg(args, agentConfig.thinkingArg, thinkingValue);
  if (!hasGitRepo()) {
    args = ensureSkipGitCheckArgs(args);
  }
  if (threadId) {
    return `${cmd} exec resume ${shellQuote(threadId)} ${args} ${promptValue}`.trim();
  }
  return `${cmd} exec ${args} ${promptValue}`.trim();
}

function buildGenericCommand(prompt, agentConfig, sessionValue, promptExpression, modelValue, thinkingValue) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const template = agentConfig.template || '';
  const cmd = agentConfig.cmd || '';
  const argsRaw = agentConfig.args || '';
  if (!template && !cmd) {
    throw new Error('Agent config missing cmd/template.');
  }
  if (template) {
    const hasPrompt = template.includes('{prompt}');
    const hasSession = template.includes('{session}');
    const hasModel = template.includes('{model}');
    const hasThinking = template.includes('{thinking}');
    const base =
      hasPrompt || hasSession || hasModel || hasThinking
        ? buildFromTemplate(template, promptValue, sessionValue, modelValue ? shellQuote(modelValue) : '', thinkingValue ? shellQuote(thinkingValue) : '')
        : template.trim();
    if (hasPrompt) {
      let command = base;
      if (!hasModel) {
        command = appendOptionalArg(command, agentConfig.modelArg, modelValue);
      }
      if (!hasThinking) {
        command = appendOptionalArg(command, agentConfig.thinkingArg, thinkingValue);
      }
      return command.trim();
    }
    let command = `${base} ${promptValue}`.trim();
    if (!hasModel) {
      command = appendOptionalArg(command, agentConfig.modelArg, modelValue);
    }
    if (!hasThinking) {
      command = appendOptionalArg(command, agentConfig.thinkingArg, thinkingValue);
    }
    return command.trim();
  }
  let command = `${cmd} ${argsRaw}`.trim();
  command = appendOptionalArg(command, agentConfig.modelArg, modelValue);
  command = appendOptionalArg(command, agentConfig.thinkingArg, thinkingValue);
  return `${command} ${promptValue}`.trim();
}

function buildAgentCommand(prompt, options, agentConfig) {
  const { chatId, threadId, promptExpression, model, thinking } = options || {};
  const sessionValue = resolveSessionValue(agentConfig, chatId, threadId);
  if (agentConfig.type === 'codex') {
    return buildCodexCommand(
      prompt,
      threadId,
      agentConfig,
      sessionValue,
      promptExpression,
      model,
      thinking
    );
  }
  return buildGenericCommand(prompt, agentConfig, sessionValue, promptExpression, model, thinking);
}

function parseCodexJsonOutput(output) {
  const lines = output.split(/\r?\n/);
  let threadId;
  const messages = [];
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
        messages.push(payload.item.text);
      }
    }
  }
  const text = messages.join('\n').trim();
  return { text, threadId, sawJson };
}

function parseAgentOutput(output, agentConfig) {
  if (agentConfig.output === 'codex-json') {
    return parseCodexJsonOutput(output);
  }
  return { text: output.trim(), threadId: undefined, sawJson: false };
}

function getAgentLabel(agentName, agentConfig) {
  return (agentConfig && agentConfig.label) || agentName || 'agent';
}

module.exports = {
  resolveAgentConfig,
  buildAgentCommand,
  parseAgentOutput,
  getAgentLabel,
};

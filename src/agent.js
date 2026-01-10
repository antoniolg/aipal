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

function buildFromTemplate(template, prompt, sessionValue) {
  return template
    .split('{prompt}')
    .join(shellQuote(prompt))
    .split('{session}')
    .join(sessionValue ? shellQuote(sessionValue) : '')
    .trim();
}

function buildCodexCommand(prompt, threadId, agentConfig, sessionValue) {
  const quoted = shellQuote(prompt);
  const template = agentConfig.template || '';
  const cmd = agentConfig.cmd || 'codex';
  const argsRaw = agentConfig.args || '';

  if (template) {
    if (template.includes('{prompt}')) {
      return buildFromTemplate(template, prompt, sessionValue);
    }
    return `${template} ${quoted}`.trim();
  }

  let args = normalizeExecArgs(argsRaw);
  args = ensureJsonArgs(args);
  if (!hasGitRepo()) {
    args = ensureSkipGitCheckArgs(args);
  }
  if (threadId) {
    return `${cmd} exec resume ${shellQuote(threadId)} ${args} ${quoted}`.trim();
  }
  return `${cmd} exec ${args} ${quoted}`.trim();
}

function buildGenericCommand(prompt, agentConfig, sessionValue) {
  const quoted = shellQuote(prompt);
  const template = agentConfig.template || '';
  const cmd = agentConfig.cmd || '';
  const argsRaw = agentConfig.args || '';
  if (template) {
    if (template.includes('{prompt}')) {
      return buildFromTemplate(template, prompt, sessionValue);
    }
    return `${template} ${quoted}`.trim();
  }
  return `${cmd} ${argsRaw} ${quoted}`.trim();
}

function buildAgentCommand(prompt, options, agentConfig) {
  const { chatId, threadId } = options || {};
  const sessionValue = resolveSessionValue(agentConfig, chatId, threadId);
  if (agentConfig.type === 'codex') {
    return buildCodexCommand(prompt, threadId, agentConfig, sessionValue);
  }
  return buildGenericCommand(prompt, agentConfig, sessionValue);
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

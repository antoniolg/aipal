const { constants: fsConstants } = require('fs');
const fs = require('fs/promises');
const path = require('path');

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

function createScriptService(options) {
  const {
    execLocal,
    isPathInside,
    scriptNameRegex,
    scriptsDir,
    scriptTimeoutMs,
    scriptContextMaxChars,
    lastScriptOutputs,
  } = options;

  async function runScriptCommand(commandName, rawArgs) {
    if (!scriptNameRegex.test(commandName)) {
      throw new Error(`Invalid script name: ${commandName}`);
    }
    const scriptPath = path.resolve(scriptsDir, commandName);
    if (!isPathInside(scriptsDir, scriptPath)) {
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
      timeout: scriptTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  function formatScriptContext(entry) {
    if (!entry) return '';
    const output = String(entry.output || '').trim() || '(no output)';
    if (output.length <= scriptContextMaxChars) {
      return `/${entry.name} output:\n${output}`;
    }
    const truncated = output.slice(0, scriptContextMaxChars);
    const remaining = output.length - scriptContextMaxChars;
    return `/${entry.name} output (truncated ${remaining} chars):\n${truncated}`;
  }

  function consumeScriptContext(topicKey) {
    const entry = lastScriptOutputs.get(topicKey);
    if (!entry) return '';
    lastScriptOutputs.delete(topicKey);
    return formatScriptContext(entry);
  }

  return {
    consumeScriptContext,
    formatScriptContext,
    runScriptCommand,
    splitArgs,
  };
}

module.exports = {
  createScriptService,
  splitArgs,
};

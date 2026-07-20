const assert = require('node:assert/strict');
const test = require('node:test');

const { createTeeLogger, resolveDevLogPath, resolveNodeCommand, shouldRestart } = require('../scripts/dev-watch');

test('resolveNodeCommand defaults to PATH node instead of process.execPath', () => {
  assert.equal(resolveNodeCommand({}), 'node');
});

test('resolveNodeCommand allows explicit override', () => {
  assert.equal(resolveNodeCommand({ AIPAL_DEV_NODE: '/custom/node' }), '/custom/node');
});

test('shouldRestart filters common source and config files', () => {
  assert.equal(shouldRestart('index.js'), true);
  assert.equal(shouldRestart('package.json'), true);
  assert.equal(shouldRestart('README.md'), true);
  assert.equal(shouldRestart('image.png'), false);
});

test('resolveDevLogPath defaults to a project-local development log', () => {
  assert.equal(resolveDevLogPath('/project', {}), '/project/.logs/dev.log');
  assert.equal(resolveDevLogPath('/project', { AIPAL_DEV_LOG: 'tmp/aipal.log' }), '/project/tmp/aipal.log');
});

test('createTeeLogger writes the same message to the terminal and log', () => {
  const terminalMessages = [];
  const logMessages = [];
  const logger = createTeeLogger(
    { write: (message) => logMessages.push(message) },
    {
      info: (...args) => terminalMessages.push(['info', ...args]),
      warn: (...args) => terminalMessages.push(['warn', ...args]),
      error: (...args) => terminalMessages.push(['error', ...args]),
    },
  );

  logger.warn('Restarting', 'src/index.js');

  assert.deepEqual(terminalMessages, [['warn', 'Restarting', 'src/index.js']]);
  assert.deepEqual(logMessages, ['Restarting src/index.js\n']);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveNodeCommand, shouldRestart } = require('../scripts/dev-watch');

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

const { test } = require('node:test');
const assert = require('node:assert');
const {
  clearProjectOverride,
  getProjectOverride,
  setProjectOverride,
} = require('../src/project-overrides');

test('project-overrides management', () => {
  const overrides = new Map();

  assert.strictEqual(getProjectOverride(overrides, 111, 222), undefined);

  setProjectOverride(overrides, 111, 222, '/Users/antonio/Projects/antoniolg/aipal');
  assert.strictEqual(
    getProjectOverride(overrides, 111, 222),
    '/Users/antonio/Projects/antoniolg/aipal'
  );

  setProjectOverride(overrides, 111, 222, '/Users/antonio/Projects/antoniolg/postflow');
  assert.strictEqual(
    getProjectOverride(overrides, 111, 222),
    '/Users/antonio/Projects/antoniolg/postflow'
  );

  clearProjectOverride(overrides, 111, 222);
  assert.strictEqual(getProjectOverride(overrides, 111, 222), undefined);
});

test('project-overrides isolate root and topic bindings', () => {
  const overrides = new Map();

  setProjectOverride(overrides, 111, undefined, '/tmp/root');
  setProjectOverride(overrides, 111, 222, '/tmp/topic');

  assert.strictEqual(getProjectOverride(overrides, 111, undefined), '/tmp/root');
  assert.strictEqual(getProjectOverride(overrides, 111, 'root'), '/tmp/root');
  assert.strictEqual(getProjectOverride(overrides, 111, 222), '/tmp/topic');
});

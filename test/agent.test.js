const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentCommand, parseAgentOutput } = require('../src/agent');

test('buildAgentCommand uses exec resume with thread id', () => {
  const command = buildAgentCommand('hello', { threadId: 't-123' });
  assert.match(command, /codex exec resume 't-123'/);
  assert.match(command, /--json/);
  assert.match(command, /'hello'/);
});

test('buildAgentCommand appends model and thinking flags', () => {
  const command = buildAgentCommand('ping', { model: 'gpt-5.2', thinking: 'medium' });
  assert.match(command, /--model 'gpt-5.2'/);
  assert.match(command, /--thinking 'medium'/);
});

test('parseAgentOutput extracts thread id and message text', () => {
  const output = [
    'noise',
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'hi there' },
    }),
  ].join('\n');
  const parsed = parseAgentOutput(output);
  assert.equal(parsed.threadId, 'thread-1');
  assert.equal(parsed.text, 'hi there');
  assert.equal(parsed.sawJson, true);
});

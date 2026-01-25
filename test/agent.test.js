const assert = require('node:assert/strict');
const test = require('node:test');

const { getAgent } = require('../src/agents');

test('buildAgentCommand uses exec resume with thread id', () => {
  const agent = getAgent('codex');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 't-123' });
  assert.match(command, /codex exec resume 't-123'/);
  assert.match(command, /--json/);
  assert.match(command, /--yolo/);
  assert.match(command, /'hello'/);
});

test('buildAgentCommand appends model and reasoning flags', () => {
  const agent = getAgent('codex');
  const command = agent.buildCommand({ prompt: 'ping', model: 'gpt-5.2', thinking: 'medium' });
  assert.match(command, /--model 'gpt-5.2'/);
  assert.match(command, /--config 'model_reasoning_effort="medium"'/);
});

test('parseAgentOutput extracts thread id and message text', () => {
  const agent = getAgent('codex');
  const output = [
    'noise',
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'hi there' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, 'thread-1');
  assert.equal(parsed.text, 'hi there');
  assert.equal(parsed.sawJson, true);
});

test('buildAgentCommand builds claude headless command with resume', () => {
  const agent = getAgent('claude');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'session-1' });
  assert.match(command, /^claude /);
  assert.match(command, /-p 'hello'/);
  assert.match(command, /--output-format json/);
  assert.match(command, /--dangerously-skip-permissions/);
  assert.match(command, /--resume 'session-1'/);
});

test('parseAgentOutput extracts claude session and result', () => {
  const agent = getAgent('claude');
  const output = JSON.stringify({ result: 'hola', session_id: 'session-2' });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, 'session-2');
  assert.equal(parsed.text, 'hola');
  assert.equal(parsed.sawJson, true);
});

test('buildAgentCommand builds gemini headless command', () => {
  const agent = getAgent('gemini');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'session-3' });
  assert.match(command, /^gemini /);
  assert.match(command, /-p 'hello'/);
  assert.match(command, /--output-format json/);
  assert.match(command, /--yolo/);
  assert.match(command, /--resume session-3/);
});

test('parseAgentOutput extracts gemini response', () => {
  const agent = getAgent('gemini');
  const output = JSON.stringify({ response: 'hola' });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, undefined);
  assert.equal(parsed.text, 'hola');
  assert.equal(parsed.sawJson, true);
});


test('parseSessionList extracts latest gemini session id', () => {
  const agent = getAgent('gemini');
  const output = [
    'Available sessions for this project (2):',
    '  1. Foo (1 minute ago) [11111111-1111-1111-1111-111111111111]',
    '  2. Bar (just now) [22222222-2222-2222-2222-222222222222]',
  ].join('\n');
  const sessionId = agent.parseSessionList(output);
  assert.equal(sessionId, '22222222-2222-2222-2222-222222222222');
});

test('buildAgentCommand builds opencode command with env and json flag', () => {
  const agent = getAgent('opencode');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'sess-123' });
  assert.match(command, /^OPENCODE_PERMISSION='\{"\*": "allow"\}' opencode run /);
  assert.match(command, /--format json/);
  assert.match(command, /--model 'opencode\/gpt-5-nano'/);
  assert.match(command, /--continue/);
  assert.match(command, /--session 'sess-123'/);
  assert.match(command, /'hello'/);
  assert.match(command, /< \/dev\/null/);
});

test('parseAgentOutput extracts opencode ndjson result', () => {
  const agent = getAgent('opencode');
  const output = [
    'INFO log message',
    JSON.stringify({ type: 'step_start', sessionID: 'sess-456' }),
    JSON.stringify({ type: 'text', sessionID: 'sess-456', part: { text: 'hi ' } }),
    JSON.stringify({ type: 'text', sessionID: 'sess-456', part: { text: 'opencode' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'sess-456' }),
  ].join('\n');

  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, 'sess-456');
  assert.equal(parsed.text, 'hi opencode');
  assert.equal(parsed.sawJson, true);
});

test('listModelsCommand builds opencode models command', () => {
  const agent = getAgent('opencode');
  const command = agent.listModelsCommand();
  assert.match(command, /opencode models/);
});



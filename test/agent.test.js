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

test('parseAgentOutput prefers final channel messages for codex', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'commentary', text: 'voy a hacer X' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'final', text: 'hecho: resultado final' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.text, 'hecho: resultado final');
});

test('parseStreamingOutput only emits codex final channel messages', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'commentary', text: 'comentario' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'final', text: 'respuesta final' },
    }),
  ].join('\n');
  const parsed = agent.parseStreamingOutput(output);
  assert.equal(parsed.sawFinal, true);
  assert.equal(parsed.text, 'respuesta final');
  assert.deepEqual(parsed.commentaryMessages, ['comentario']);
});

test('parseAgentOutput understands Codex session response_item phases', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'voy a revisar esto' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'resultado final' }],
      },
    }),
  ].join('\n');

  const parsed = agent.parseOutput(output);
  assert.equal(parsed.text, 'resultado final');
});

test('parseStreamingOutput understands Codex event_msg agent_message phases', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'commentary',
        message: 'comprobando estado',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'final_answer',
        message: 'hecho',
      },
    }),
  ].join('\n');

  const parsed = agent.parseStreamingOutput(output);
  assert.equal(parsed.sawFinal, true);
  assert.equal(parsed.text, 'hecho');
  assert.deepEqual(parsed.commentaryMessages, ['comprobando estado']);
});

test('parseStreamingOutput infers commentary and final from agent_message stream', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Voy a comprobar algo' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'Sigo mirando el repo' },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join('\n');

  const parsed = agent.parseStreamingOutput(output);
  assert.equal(parsed.sawFinal, true);
  assert.equal(parsed.text, 'Sigo mirando el repo');
  assert.deepEqual(parsed.commentaryMessages, []);
});

test('parseStreamingOutput keeps live agent_message entries pending before turn completion', () => {
  const agent = getAgent('codex');
  const output = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'Voy a comprobar algo' },
  });

  const parsed = agent.parseStreamingOutput(output);
  assert.equal(parsed.sawFinal, false);
  assert.equal(parsed.text, '');
  assert.deepEqual(parsed.commentaryMessages, []);
});

test('parseStreamingOutput does not leak unphased final text into commentary', () => {
  const agent = getAgent('codex');
  const output = JSON.stringify({
    type: 'item.completed',
    item: { type: 'message', text: 'respuesta final sin phase' },
  });

  const parsed = agent.parseStreamingOutput(output);
  assert.equal(parsed.sawFinal, false);
  assert.equal(parsed.text, '');
  assert.deepEqual(parsed.commentaryMessages, []);
});

test('parseAgentOutput falls back to last codex message when no channel exists', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'paso intermedio' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'respuesta final' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.text, 'respuesta final');
});

test('buildAgentCommand builds claude headless command with resume', () => {
  const agent = getAgent('claude');
  const command = agent.buildCommand({
    prompt: 'hello',
    threadId: '550e8400-e29b-41d4-a716-446655440000',
  });
  assert.match(command, /^claude /);
  assert.match(command, /-p 'hello'/);
  assert.match(command, /--output-format json/);
  assert.match(command, /--dangerously-skip-permissions/);
  assert.match(command, /--resume '550e8400-e29b-41d4-a716-446655440000'/);
});

test('parseAgentOutput extracts claude session and result', () => {
  const agent = getAgent('claude');
  const output = JSON.stringify({
    result: 'hola',
    session_id: '550e8400-e29b-41d4-a716-446655440000',
  });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(parsed.text, 'hola');
  assert.equal(parsed.sawJson, true);
});

test('buildAgentCommand omits claude resume when thread id is invalid', () => {
  const agent = getAgent('claude');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'not-a-uuid' });
  assert.doesNotMatch(command, /--resume/);
});

test('parseAgentOutput sanitizes claude session id with trailing quote/backslash', () => {
  const agent = getAgent('claude');
  const output = JSON.stringify({
    result: 'ok',
    session_id: '82a2961c-919a-4ac2-bcb5-fcb341ef32db\\"',
  });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, '82a2961c-919a-4ac2-bcb5-fcb341ef32db');
  assert.equal(parsed.text, 'ok');
});

test('parseStreamingOutput emits a final Claude response once JSON is complete', () => {
  const agent = getAgent('claude');
  const parsed = agent.parseStreamingOutput(
    JSON.stringify({
      result: 'hola desde streaming',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
    })
  );
  assert.equal(parsed.sawFinal, true);
  assert.equal(parsed.text, 'hola desde streaming');
  assert.equal(parsed.threadId, '550e8400-e29b-41d4-a716-446655440000');
  assert.deepEqual(parsed.commentaryMessages, []);
});

test('parseStreamingOutput ignores incomplete Claude JSON', () => {
  const agent = getAgent('claude');
  const parsed = agent.parseStreamingOutput('{"result":"hola');
  assert.equal(parsed.sawFinal, false);
  assert.equal(parsed.text, '');
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

test('parseStreamingOutput emits a final Gemini response once JSON is complete', () => {
  const agent = getAgent('gemini');
  const parsed = agent.parseStreamingOutput(
    JSON.stringify({ response: 'hola gemini' })
  );
  assert.equal(parsed.sawFinal, true);
  assert.equal(parsed.text, 'hola gemini');
  assert.deepEqual(parsed.commentaryMessages, []);
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

test('codex-app agent is registered as an app-server backend', () => {
  const agent = getAgent('codex-app');
  assert.equal(agent.id, 'codex-app');
  assert.equal(agent.backend, 'app-server');
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

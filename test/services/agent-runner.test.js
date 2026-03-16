const assert = require('node:assert/strict');
const test = require('node:test');

const { createAgentRunner } = require('../../src/services/agent-runner');
const { getAgent } = require('../../src/agents');

function buildRunner(overrides = {}) {
  const threads = new Map();
  const threadTurns = new Map();
  const persistedThreadSnapshots = [];

  const runner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 30_000,
    buildBootstrapContext: async () => 'bootstrap',
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (prompt) => prompt,
    documentDir: '/tmp/aipal/documents',
    execLocal: async () => '',
    execLocalStreaming: async () => '',
    fileInstructionsEvery: 3,
    getAgent,
    getAgentLabel: (id) => id,
    getGlobalAgent: () => 'codex',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => null,
    getThreads: () => threads,
    imageDir: '/tmp/aipal/images',
    memoryRetrievalLimit: 0,
    persistThreads: async () => {
      persistedThreadSnapshots.push(new Map(threads));
    },
    postFinalGraceMs: 5,
    prefixTextWithTimestamp: (text) => text,
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex',
    resolveThreadId: (_threads, chatId, topicId, agentId) => ({
      threadKey: `${chatId}:${topicId || 'root'}:${agentId}`,
      threadId: undefined,
      migrated: false,
    }),
    shellQuote: (value) => `'${String(value)}'`,
    terminateChildProcess: () => {},
    threadTurns,
    wrapCommandWithPty: (value) => value,
    defaultTimeZone: 'Europe/Madrid',
    ...overrides,
  });

  return { runner, threads, persistedThreadSnapshots };
}

test('runAgentForChat streams codex final response before process exit', async () => {
  const order = [];
  const progressUpdates = [];
  let resolveExec;
  const execDone = new Promise((resolve) => {
    resolveExec = resolve;
  });

  const outputLines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'final', text: 'respuesta final' },
    }),
  ];

  const { runner, threads, persistedThreadSnapshots } = buildRunner({
    execLocalStreaming: async (_cmd, _args, options) => {
      options.onStdout(`${outputLines[0]}\n`);
      options.onStdout(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'commentary', text: 'revisando archivos' },
        })}\n`
      );
      options.onStdout(`${outputLines[1]}\n`);
      order.push('stdout-finished');
      await execDone;
      return `${outputLines.join('\n')}\n`;
    },
  });

  const runPromise = runner.runAgentForChat(42, 'hola', {
    onProgressUpdate: async (lines) => {
      progressUpdates.push(lines.slice());
    },
    onFinalResponse: async (text) => {
      order.push(`callback:${text}`);
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(order.includes('callback:respuesta final'));

  resolveExec();
  const response = await runPromise;

  assert.equal(response, 'respuesta final');
  assert.deepEqual(progressUpdates, [['revisando archivos']]);
  assert.equal(threads.get('42:root:codex'), 'thread-123');
  assert.equal(persistedThreadSnapshots.length, 1);
});

test('runAgentForChat kills a lingering process after final emission and drops late progress', async () => {
  const progressUpdates = [];
  const settled = [];
  const killCalls = [];
  const child = { pid: 999, kill: () => {} };

  const { runner } = buildRunner({
    execLocalStreaming: async (_cmd, _args, options) => {
      options.onSpawn(child);
      options.onStdout(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'commentary', text: 'primer paso' },
        })}\n`
      );
      options.onStdout(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'final', text: 'resultado listo' },
        })}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      options.onStdout(
        `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'commentary', text: 'esto debe ignorarse' },
        })}\n`
      );
      return [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'commentary', text: 'primer paso' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', channel: 'final', text: 'resultado listo' },
        }),
      ].join('\n');
    },
    terminateChildProcess: (processRef, signal) => {
      killCalls.push({ processRef, signal });
    },
  });

  const response = await runner.runAgentForChat(99, 'hola', {
    onProgressUpdate: async (lines) => {
      progressUpdates.push(lines.slice());
    },
    onSettled: async (payload) => {
      settled.push(payload);
    },
  });

  assert.equal(response, 'resultado listo');
  assert.deepEqual(progressUpdates, [['primer paso']]);
  assert.equal(killCalls.length >= 1, true);
  assert.equal(killCalls[0].processRef, child);
  assert.equal(killCalls[0].signal, 'SIGTERM');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'succeeded');
  assert.equal(settled[0].finalEmitted, true);
  assert.equal(settled[0].droppedProgressUpdates, 1);
});

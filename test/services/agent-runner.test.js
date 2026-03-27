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

test('runAgentForChat uses the session-backed codex-app backend and persists thread ids', async () => {
  const progressUpdates = [];
  const finalResponses = [];
  const calls = [];

  const { runner, threads, persistedThreadSnapshots } = buildRunner({
    execLocal: async () => {
      throw new Error('shell path should not be used for codex-app');
    },
    execLocalStreaming: async () => {
      throw new Error('streaming shell path should not be used for codex-app');
    },
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      calls.push(options);
      await options.onProgressUpdate(['recuperando contexto']);
      return {
        text: 'respuesta codex-app',
        threadId: 'app-thread-1',
        turnId: 'turn-1',
      };
    },
  });

  const response = await runner.runAgentForChat(7, 'hola desde telegram', {
    imagePaths: ['/tmp/aipal/images/capture.png'],
    onFinalResponse: async (text) => {
      finalResponses.push(text);
    },
    onProgressUpdate: async (lines) => {
      progressUpdates.push(lines.slice());
    },
  });

  assert.equal(response, 'respuesta codex-app');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, 'codex-app');
  assert.equal(calls[0].chatId, 7);
  assert.equal(calls[0].threadId, undefined);
  assert.match(calls[0].prompt, /hola desde telegram/);
  assert.deepEqual(calls[0].imagePaths, ['/tmp/aipal/images/capture.png']);
  assert.deepEqual(progressUpdates, [['recuperando contexto']]);
  assert.deepEqual(finalResponses, ['respuesta codex-app']);
  assert.equal(threads.get('7:root:codex-app'), 'app-thread-1');
  assert.equal(persistedThreadSnapshots.length, 1);
});

test('runAgentForChat reuses a resumed codex-app thread binding', async () => {
  const calls = [];
  const { runner, threads } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    resolveThreadId: (_threads, chatId, topicId, agentId) => ({
      threadKey: `${chatId}:${topicId || 'root'}:${agentId}`,
      threadId: threads.get(`${chatId}:${topicId || 'root'}:${agentId}`),
      migrated: false,
    }),
    runSessionBackedChatTurn: async (options) => {
      calls.push(options);
      return {
        text: 'respuesta reanudada',
        threadId: options.threadId,
        turnId: 'turn-resumed',
      };
    },
  });

  threads.set('17:root:codex-app', 'thread-resumed');
  const response = await runner.runAgentForChat(17, 'sigue por aqui', {
    agentId: 'codex-app',
  });

  assert.equal(response, 'respuesta reanudada');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, 'thread-resumed');
});

test('runAgentForChat assigns a title when a new codex-app thread is created', async () => {
  const titleCalls = [];
  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async () => ({
      text: 'respuesta titulada',
      threadId: 'thread-title',
      turnId: 'turn-title',
    }),
    setSessionBackedThreadTitle: async (options) => {
      titleCalls.push(options);
    },
  });

  await runner.runAgentForChat(
    18,
    'revisa aipal y dime qué hace el diff actual',
    { agentId: 'codex-app' }
  );

  assert.deepEqual(titleCalls, [
    {
      agentId: 'codex-app',
      threadId: 'thread-title',
      title: 'revisa aipal y dime qué hace el diff actual',
    },
  ]);
});

test('runAgentForChat does not retitle an existing codex-app thread', async () => {
  const titleCalls = [];
  const { runner, threads } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    resolveThreadId: (_threads, chatId, topicId, agentId) => ({
      threadKey: `${chatId}:${topicId || 'root'}:${agentId}`,
      threadId: threads.get(`${chatId}:${topicId || 'root'}:${agentId}`),
      migrated: false,
    }),
    runSessionBackedChatTurn: async (options) => ({
      text: 'respuesta',
      threadId: options.threadId,
      turnId: 'turn-existing',
    }),
    setSessionBackedThreadTitle: async (options) => {
      titleCalls.push(options);
    },
  });

  threads.set('19:root:codex-app', 'thread-existing');
  await runner.runAgentForChat(19, 'otro mensaje', { agentId: 'codex-app' });

  assert.deepEqual(titleCalls, []);
});

test('runAgentOneShot uses the session-backed codex-app backend', async () => {
  const calls = [];
  const { runner } = buildRunner({
    execLocal: async () => {
      throw new Error('shell one-shot should not be used for codex-app');
    },
    getGlobalAgent: () => 'codex-app',
    getGlobalModels: () => ({ 'codex-app': 'gpt-5.4-codex' }),
    getGlobalThinking: () => 'high',
    runSessionBackedOneShot: async (options) => {
      calls.push(options);
      return { text: 'respuesta efimera' };
    },
  });

  const response = await runner.runAgentOneShot('resume este script');

  assert.equal(response, 'respuesta efimera');
  assert.deepEqual(calls, [
    {
      agentId: 'codex-app',
      effort: 'high',
      model: 'gpt-5.4-codex',
      prompt: 'resume este script',
    },
  ]);
});

test('stopActiveRun interrupts an active codex-app session-backed turn', async () => {
  let resolveTurn;
  const turnDone = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const stopCalls = [];

  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      options.onTurnStarted({ threadId: 'thread-stop', turnId: 'turn-stop' });
      await turnDone;
      return { text: '', threadId: 'thread-stop', turnId: 'turn-stop' };
    },
    stopSessionBackedTurn: async (options) => {
      stopCalls.push(options);
      resolveTurn();
    },
  });

  const runPromise = runner.runAgentForChat(77, 'hola', {
    agentId: 'codex-app',
  });

  let result = await runner.stopActiveRun(77, undefined, 'codex-app');
  for (
    let i = 0;
    i < 10 && (result.status === 'idle' || result.status === 'not_ready');
    i += 1
  ) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await runner.stopActiveRun(77, undefined, 'codex-app');
  }
  await runPromise;

  assert.equal(result.status, 'stopping');
  assert.deepEqual(stopCalls, [
    {
      agentId: 'codex-app',
      threadId: 'thread-stop',
      turnId: 'turn-stop',
    },
  ]);
});

test('stopActiveRun queues an early stop until the codex-app turn is ready', async () => {
  let resolveTurn;
  const turnDone = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const stopCalls = [];

  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      await new Promise((resolve) => setImmediate(resolve));
      options.onTurnStarted({ threadId: 'thread-queued', turnId: 'turn-queued' });
      await turnDone;
      return { text: '', threadId: 'thread-queued', turnId: 'turn-queued' };
    },
    stopSessionBackedTurn: async (options) => {
      stopCalls.push(options);
      resolveTurn();
    },
  });

  const runPromise = runner.runAgentForChat(88, 'hola', {
    agentId: 'codex-app',
  });

  let result = await runner.stopActiveRun(88, undefined, 'codex-app');
  for (let i = 0; i < 10 && result.status === 'idle'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await runner.stopActiveRun(88, undefined, 'codex-app');
  }
  await runPromise;

  assert.equal(result.status, 'queued');
  assert.deepEqual(stopCalls, [
    {
      agentId: 'codex-app',
      threadId: 'thread-queued',
      turnId: 'turn-queued',
    },
  ]);
});

test('getActiveRunState reports codex-app activity for the topic', async () => {
  let resolveTurn;
  const turnDone = new Promise((resolve) => {
    resolveTurn = resolve;
  });

  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      options.onTurnStarted({ threadId: 'thread-status', turnId: 'turn-status' });
      await turnDone;
      return { text: 'ok', threadId: 'thread-status', turnId: 'turn-status' };
    },
  });

  const runPromise = runner.runAgentForChat(121, 'hola', {
    agentId: 'codex-app',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const activeState = runner.getActiveRunState(121, undefined, 'codex-app');
  assert.equal(activeState.active, true);
  assert.equal(activeState.threadId, 'thread-status');
  assert.equal(activeState.turnId, 'turn-status');

  resolveTurn();
  await runPromise;

  const idleState = runner.getActiveRunState(121, undefined, 'codex-app');
  assert.equal(idleState.active, false);
});

test('steerActiveRun sends steer requests to an active codex-app turn', async () => {
  let resolveTurn;
  const turnDone = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const steerCalls = [];

  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      options.onTurnStarted({ threadId: 'thread-steer', turnId: 'turn-steer' });
      await turnDone;
      return { text: 'listo', threadId: 'thread-steer', turnId: 'turn-steer' };
    },
    steerSessionBackedTurn: async (options) => {
      steerCalls.push(options);
      resolveTurn();
    },
  });

  const runPromise = runner.runAgentForChat(91, 'hola', {
    agentId: 'codex-app',
  });

  let result = await runner.steerActiveRun(91, undefined, 'y mira los tests', 'codex-app');
  for (let i = 0; i < 10 && result.status === 'idle'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await runner.steerActiveRun(91, undefined, 'y mira los tests', 'codex-app');
  }

  await runPromise;

  assert.equal(result.status, 'steered');
  assert.deepEqual(steerCalls, [
    {
      agentId: 'codex-app',
      input: [{ type: 'text', text: 'y mira los tests' }],
      threadId: 'thread-steer',
      turnId: 'turn-steer',
    },
  ]);
});

test('steerActiveRun queues steer input until the codex-app turn is ready', async () => {
  let resolveTurn;
  const turnDone = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const steerCalls = [];

  const { runner } = buildRunner({
    getGlobalAgent: () => 'codex-app',
    resolveEffectiveAgentId: (_chatId, _topicId, overrideAgentId) =>
      overrideAgentId || 'codex-app',
    runSessionBackedChatTurn: async (options) => {
      await new Promise((resolve) => setImmediate(resolve));
      options.onTurnStarted({ threadId: 'thread-queued-steer', turnId: 'turn-queued-steer' });
      await turnDone;
      return {
        text: 'listo',
        threadId: 'thread-queued-steer',
        turnId: 'turn-queued-steer',
      };
    },
    steerSessionBackedTurn: async (options) => {
      steerCalls.push(options);
      resolveTurn();
    },
  });

  const runPromise = runner.runAgentForChat(92, 'hola', {
    agentId: 'codex-app',
  });

  let result = await runner.steerActiveRun(92, undefined, 'ten en cuenta el diff', 'codex-app');
  for (let i = 0; i < 10 && result.status === 'idle'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await runner.steerActiveRun(
      92,
      undefined,
      'ten en cuenta el diff',
      'codex-app'
    );
  }

  await runPromise;

  assert.equal(result.status, 'queued');
  assert.deepEqual(steerCalls, [
    {
      agentId: 'codex-app',
      input: [{ type: 'text', text: 'ten en cuenta el diff' }],
      threadId: 'thread-queued-steer',
      turnId: 'turn-queued-steer',
    },
  ]);
});

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createCodexAppServerClient,
} = require('../../src/services/codex-app-server');

function createSpawnHarness(onMessage) {
  const spawns = [];

  function spawnProcess(cmd, args, opts) {
    const proc = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');

    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.killed = false;
    proc.kill = (signal = 'SIGTERM') => {
      proc.killed = true;
      proc.emit('close', null, signal);
    };

    const state = {
      args,
      cmd,
      messages: [],
      opts,
      proc,
      send(payload) {
        stdout.write(`${JSON.stringify(payload)}\n`);
      },
    };
    spawns.push(state);

    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += String(chunk || '');
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        state.messages.push(message);
        onMessage(state, message);
      }
    });

    return proc;
  }

  return {
    spawnProcess,
    spawns,
  };
}

test('codex app server client initializes, streams raw progress, and returns final text', async () => {
  const progressUpdates = [];
  const finalResponses = [];
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: { serverInfo: { name: 'codex-app-server' } } });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { id: 'msg-1', type: 'agentMessage', phase: 'commentary' },
          },
        });
        state.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'msg-1',
            delta: 'revisando archivos',
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'msg-2',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'respuesta final',
            },
          },
        });
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const result = await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola' }],
    onFinalResponse: (text) => {
      finalResponses.push(text);
    },
    onProgressUpdate: (payload) => {
      progressUpdates.push(payload);
    },
  });

  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].cmd, 'codex');
  assert.deepEqual(harness.spawns[0].args, ['app-server']);
  assert.equal(harness.spawns[0].opts.cwd, process.cwd());
  assert.equal(
    harness.spawns[0].opts.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
    'aipal'
  );
  assert.equal(harness.spawns[0].messages[0].method, 'initialize');
  assert.equal(harness.spawns[0].messages[1].method, 'initialized');
  assert.equal(harness.spawns[0].messages[2].method, 'thread/start');
  assert.equal(harness.spawns[0].messages[3].method, 'turn/start');
  assert.equal(
    harness.spawns[0].messages[3].params.approvalPolicy,
    'on-request'
  );
  assert.deepEqual(
    harness.spawns[0].messages[3].params.sandboxPolicy,
    { type: 'dangerFullAccess' }
  );
  assert.deepEqual(progressUpdates, [{ mode: 'raw', text: 'revisando archivos' }]);
  assert.deepEqual(finalResponses, ['respuesta final']);
  assert.equal(result.text, 'respuesta final');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');

  await client.shutdown();
});

test('codex app server client sends default personality on thread/start and turn/start', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: { serverInfo: { name: 'codex-app-server' } } });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-friendly' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-friendly' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-friendly',
            turn: { id: 'turn-friendly', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    defaultPersonality: 'friendly',
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola' }],
  });

  assert.equal(harness.spawns[0].messages[2].method, 'thread/start');
  assert.equal(harness.spawns[0].messages[2].params.personality, 'friendly');
  assert.equal(harness.spawns[0].messages[3].method, 'turn/start');
  assert.equal(harness.spawns[0].messages[3].params.personality, 'friendly');

  await client.shutdown();
});

test('codex app server client sends default personality on thread/resume', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: { serverInfo: { name: 'codex-app-server' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      state.send({ id: message.id, result: { thread: { id: 'thread-existing' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-existing' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-existing',
            turn: { id: 'turn-existing', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    defaultPersonality: 'friendly',
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola otra vez' }],
    threadId: 'thread-existing',
  });

  assert.equal(harness.spawns[0].messages[2].method, 'thread/resume');
  assert.equal(harness.spawns[0].messages[2].params.threadId, 'thread-existing');
  assert.equal(harness.spawns[0].messages[2].params.personality, 'friendly');
  assert.equal(harness.spawns[0].messages[3].method, 'turn/start');
  assert.equal(harness.spawns[0].messages[3].params.personality, 'friendly');

  await client.shutdown();
});

test('codex app server client forwards service tier on thread/start and turn/start', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: { serverInfo: { name: 'codex-app-server' } } });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-fast' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-fast' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-fast',
            turn: { id: 'turn-fast', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola' }],
    serviceTier: 'fast',
  });

  assert.equal(harness.spawns[0].messages[2].method, 'thread/start');
  assert.equal(harness.spawns[0].messages[2].params.serviceTier, 'fast');
  assert.equal(harness.spawns[0].messages[3].method, 'turn/start');
  assert.equal(harness.spawns[0].messages[3].params.serviceTier, 'fast');

  await client.shutdown();
});

test('codex app server client forwards service tier on thread/resume', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: { serverInfo: { name: 'codex-app-server' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      state.send({ id: message.id, result: { thread: { id: 'thread-fast-existing' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-fast-existing' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-fast-existing',
            turn: { id: 'turn-fast-existing', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola otra vez' }],
    serviceTier: 'fast',
    threadId: 'thread-fast-existing',
  });

  assert.equal(harness.spawns[0].messages[2].method, 'thread/resume');
  assert.equal(harness.spawns[0].messages[2].params.threadId, 'thread-fast-existing');
  assert.equal(harness.spawns[0].messages[2].params.serviceTier, 'fast');
  assert.equal(harness.spawns[0].messages[3].method, 'turn/start');
  assert.equal(harness.spawns[0].messages[3].params.serviceTier, 'fast');

  await client.shutdown();
});

test('codex app server client lists threads and reads thread state', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/list') {
      state.send({
        id: message.id,
        result: {
          data: [
            {
              id: 'thread-2',
              title: 'Sesion dos',
              cwd: '/tmp/b',
              originator: 'codex_cli_rs',
              updatedAt: 200,
              source: 'cli',
            },
            {
              id: 'thread-1',
              title: 'Sesion uno',
              cwd: '/tmp/a',
              originator: 'aipal',
              updatedAt: 100,
              source: { custom: 'aipal' },
            },
          ],
        },
      });
      return;
    }
    if (message.method === 'thread/resume') {
      state.send({
        id: message.id,
        result: {
          thread: {
            id: 'thread-2',
            title: 'Sesion dos',
            cwd: '/tmp/b',
            model: 'gpt-5.4-codex',
            reasoningEffort: 'high',
          },
        },
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const threads = await client.listThreads({ query: 'sesion' });
  assert.equal(threads.length, 2);
  assert.equal(threads[0].threadId, 'thread-2');
  assert.equal(threads[0].title, 'Sesion dos');
  assert.equal(threads[0].cwd, '/tmp/b');
  assert.equal(threads[0].originator, 'codex_cli_rs');
  assert.equal(threads[0].sourceKind, 'cli');
  assert.equal(threads[0].sourceLabel, 'cli');
  assert.equal(threads[1].originator, 'aipal');
  assert.equal(threads[1].sourceCustom, 'aipal');

  const threadState = await client.readThreadState({ threadId: 'thread-2' });
  assert.equal(threadState.threadId, 'thread-2');
  assert.equal(threadState.title, 'Sesion dos');
  assert.equal(threadState.cwd, '/tmp/b');
  assert.equal(threadState.model, 'gpt-5.4-codex');
  assert.equal(threadState.reasoningEffort, 'high');

  await client.shutdown();
});

test('codex app server client sets thread names', async () => {
  let renamePayload = null;
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/name/set') {
      renamePayload = message.params;
      state.send({ id: message.id, result: {} });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.setThreadName({
    name: 'Revisar diff de aipal',
    threadId: 'thread-rename',
  });

  assert.deepEqual(renamePayload, {
    name: 'Revisar diff de aipal',
    threadId: 'thread-rename',
  });

  await client.shutdown();
});

test('codex app server client exposes forkThread', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/fork') {
      state.send({
        id: message.id,
        result: {
          thread: { id: 'thread-forked' },
        },
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const forkedThreadId = await client.forkThread({ threadId: 'thread-original' });
  assert.equal(forkedThreadId, 'thread-forked');

  await client.shutdown();
});

test('codex app server client routes approval requests and resolution events', async () => {
  const approvals = [];
  const resolvedRequests = [];
  let approvalResponse = null;
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-approve' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-approve' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/started',
          params: { threadId: 'thread-approve', turn: { id: 'turn-approve' } },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-approve',
            turnId: 'turn-approve',
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              command: 'npm test',
            },
          },
        });
        state.send({
          id: 91,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-approve',
            itemId: 'cmd-1',
            command: 'npm test',
            cwd: '/tmp/demo',
            reason: 'Necesita ejecutar tests',
          },
        });
      });
      return;
    }
    if (message.id === 91 && message.result) {
      approvalResponse = message;
      state.send({
        method: 'serverRequest/resolved',
        params: {
          requestId: 91,
          threadId: 'thread-approve',
        },
      });
      state.send({
        method: 'item/completed',
        params: {
          threadId: 'thread-approve',
          turnId: 'turn-approve',
          item: {
            id: 'msg-final',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'tests listos',
          },
        },
      });
      state.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-approve',
          turn: { id: 'turn-approve', status: 'completed' },
        },
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const result = await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'ejecuta tests' }],
    onApprovalResolved: (payload) => {
      resolvedRequests.push(payload);
    },
    requestApproval: async (request) => {
      approvals.push(request);
      return 'acceptForSession';
    },
  });

  assert.equal(result.text, 'tests listos');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'command_execution');
  assert.equal(approvals[0].requestId, 91);
  assert.equal(approvals[0].item.id, 'cmd-1');
  assert.equal(approvalResponse.result.decision, 'acceptForSession');
  assert.deepEqual(resolvedRequests, [{ requestId: 91, threadId: 'thread-approve' }]);

  await client.shutdown();
});

test('codex app server client ignores reasoning and command progress noise', async () => {
  const progressUpdates = [];
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-progress' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-progress' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/started',
          params: { threadId: 'thread-progress', turn: { id: 'turn-progress' } },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-progress',
            turnId: 'turn-progress',
            item: { id: 'reason-1', type: 'reasoning' },
          },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-progress',
            turnId: 'turn-progress',
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              command: "/bin/zsh -lc 'git diff --stat'",
            },
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-progress',
            turnId: 'turn-progress',
            item: {
              id: 'msg-final',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'hecho',
            },
          },
        });
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-progress',
            turn: { id: 'turn-progress', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const result = await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola' }],
    onProgressUpdate: (payload) => {
      progressUpdates.push(payload);
    },
  });

  assert.equal(result.text, 'hecho');
  assert.deepEqual(progressUpdates, []);

  await client.shutdown();
});

test('codex app server client clears stale tool progress when the item completes', async () => {
  const progressUpdates = [];
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-tool' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-tool' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/started',
          params: { threadId: 'thread-tool', turn: { id: 'turn-tool' } },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-tool',
            turnId: 'turn-tool',
            item: { id: 'tool-1', type: 'mcpToolCall', name: 'grep' },
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-tool',
            turnId: 'turn-tool',
            item: { id: 'tool-1', type: 'mcpToolCall', name: 'grep' },
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-tool',
            turnId: 'turn-tool',
            item: {
              id: 'msg-1',
              type: 'agentMessage',
              phase: 'commentary',
              text: 'Leyendo el repo...',
            },
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-tool',
            turnId: 'turn-tool',
            item: {
              id: 'msg-final',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'hecho',
            },
          },
        });
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-tool',
            turn: { id: 'turn-tool', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const result = await client.runChatTurn({
    cwd: '/tmp/demo',
    input: [{ type: 'text', text: 'hola' }],
    onProgressUpdate: (payload) => {
      progressUpdates.push(payload);
    },
  });

  assert.equal(result.text, 'hecho');
  assert.deepEqual(progressUpdates, [
    { mode: 'raw', text: 'Usando herramienta: grep' },
    { mode: 'raw', text: 'Leyendo el repo...' },
  ]);

  await client.shutdown();
});

test('codex app server client can ignore agent deltas and emit only completed commentary', async () => {
  const progressUpdates = [];
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/start') {
      state.send({ id: message.id, result: { thread: { id: 'thread-complete-only' } } });
      return;
    }
    if (message.method === 'turn/start') {
      state.send({ id: message.id, result: { turn: { id: 'turn-complete-only' } } });
      queueMicrotask(() => {
        state.send({
          method: 'turn/started',
          params: {
            threadId: 'thread-complete-only',
            turn: { id: 'turn-complete-only' },
          },
        });
        state.send({
          method: 'item/started',
          params: {
            threadId: 'thread-complete-only',
            turnId: 'turn-complete-only',
            item: { id: 'msg-1', type: 'agentMessage', phase: 'commentary' },
          },
        });
        state.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-complete-only',
            turnId: 'turn-complete-only',
            itemId: 'msg-1',
            delta: 'trozo 1',
          },
        });
        state.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-complete-only',
            turnId: 'turn-complete-only',
            itemId: 'msg-1',
            delta: ' y trozo 2',
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-complete-only',
            turnId: 'turn-complete-only',
            item: {
              id: 'msg-1',
              type: 'agentMessage',
              phase: 'commentary',
              text: 'mensaje completo',
            },
          },
        });
        state.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-complete-only',
            turnId: 'turn-complete-only',
            item: {
              id: 'msg-final',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'hecho',
            },
          },
        });
        state.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-complete-only',
            turn: { id: 'turn-complete-only', status: 'completed' },
          },
        });
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const result = await client.runChatTurn({
    cwd: '/tmp/demo',
    includeAgentDeltas: false,
    input: [{ type: 'text', text: 'hola' }],
    onProgressUpdate: (payload) => {
      progressUpdates.push(payload);
    },
  });

  assert.equal(result.text, 'hecho');
  assert.deepEqual(progressUpdates, [{ mode: 'raw', text: 'mensaje completo' }]);

  await client.shutdown();
});

test('codex app server client respawns after the server exits', async () => {
  let spawnCount = 0;
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'model/list') {
      spawnCount += 1;
      state.send({
        id: message.id,
        result: {
          data: [{ id: `model-${spawnCount}` }],
        },
      });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  const first = await client.listModels();
  assert.equal(first[0].id, 'model-1');

  harness.spawns[0].proc.emit('close', 0, null);

  const second = await client.listModels();
  assert.equal(second[0].id, 'model-2');
  assert.equal(harness.spawns.length, 2);

  await client.shutdown();
});

test('codex app server client exposes interruptTurn', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'turn/interrupt') {
      state.send({ id: message.id, result: {} });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });

  assert.equal(harness.spawns[0].messages[2].method, 'turn/interrupt');
  assert.deepEqual(harness.spawns[0].messages[2].params, {
    threadId: 'thread-1',
    turnId: 'turn-1',
  });

  await client.shutdown();
});

test('codex app server client exposes steerTurn', async () => {
  const logger = { warn() {} };
  const harness = createSpawnHarness((state, message) => {
    if (message.method === 'initialize') {
      state.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'turn/steer') {
      state.send({ id: message.id, result: { turnId: 'turn-1' } });
    }
  });

  const client = createCodexAppServerClient({
    logger,
    spawnProcess: harness.spawnProcess,
  });

  await client.steerTurn({
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'Añade esta nota' }],
    threadId: 'thread-1',
  });

  assert.equal(harness.spawns[0].messages[2].method, 'turn/steer');
  assert.deepEqual(harness.spawns[0].messages[2].params, {
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'Añade esta nota' }],
    threadId: 'thread-1',
  });

  await client.shutdown();
});

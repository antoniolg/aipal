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

test('codex app server client initializes, streams commentary, and returns final text', async () => {
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
    onProgressUpdate: (lines) => {
      progressUpdates.push(lines.slice());
    },
  });

  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].cmd, 'codex');
  assert.deepEqual(harness.spawns[0].args, ['app-server', '--session-source', 'aipal']);
  assert.equal(harness.spawns[0].opts.cwd, process.cwd());
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
  assert.deepEqual(
    progressUpdates.filter((lines) => lines.length > 0),
    [['revisando archivos']]
  );
  assert.deepEqual(finalResponses, ['respuesta final']);
  assert.equal(result.text, 'respuesta final');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');

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

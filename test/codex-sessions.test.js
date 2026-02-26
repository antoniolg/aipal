const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getLocalCodexSessionLastMessage,
  isValidSessionId,
  listLocalCodexSessions,
} = require('../src/services/codex-sessions');

async function writeSessionFile(baseDir, relativePath, payload) {
  const filePath = path.join(baseDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: payload.timestamp,
      type: 'session_meta',
      payload: {
        id: payload.id,
        timestamp: payload.timestamp,
        cwd: payload.cwd,
      },
    })}\n{"type":"response_item","payload":{"type":"message"}}\n`,
    'utf8'
  );
}

test('listLocalCodexSessions returns most recent sessions and supports cwd filter', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-codex-sessions-'));
  const sessionsDir = path.join(tmp, 'sessions');

  await writeSessionFile(
    sessionsDir,
    '2026/02/24/rollout-2026-02-24T09-00-00-019abcde-1111-7222-8333-1234567890ab.jsonl',
    {
      id: '019abcde-1111-7222-8333-1234567890ab',
      timestamp: '2026-02-24T09:00:00.000Z',
      cwd: '/Users/jfmargar/Workspace/project-a',
    }
  );
  await writeSessionFile(
    sessionsDir,
    '2026/02/25/rollout-2026-02-25T09-00-00-019abcde-2222-7222-8333-1234567890cd.jsonl',
    {
      id: '019abcde-2222-7222-8333-1234567890cd',
      timestamp: '2026-02-25T09:00:00.000Z',
      cwd: '/Users/jfmargar/Workspace/project-b/subdir',
    }
  );

  const all = await listLocalCodexSessions({ sessionsDir, limit: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, '019abcde-2222-7222-8333-1234567890cd');
  assert.equal(all[1].id, '019abcde-1111-7222-8333-1234567890ab');

  const filtered = await listLocalCodexSessions({
    sessionsDir,
    limit: 10,
    cwd: '/Users/jfmargar/Workspace/project-b',
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, '019abcde-2222-7222-8333-1234567890cd');
});

test('isValidSessionId validates codex-like ids', () => {
  assert.equal(isValidSessionId('019abcde-2222-7222-8333-1234567890cd'), true);
  assert.equal(isValidSessionId('not-a-session'), false);
});

test('getLocalCodexSessionLastMessage reads text from latest session lines', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-codex-session-tail-'));
  const sessionsDir = path.join(tmp, 'sessions');
  const filePath = path.join(
    sessionsDir,
    '2026/02/25/rollout-2026-02-25T09-00-00-019abcde-3333-7222-8333-1234567890ef.jsonl'
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        timestamp: '2026-02-25T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019abcde-3333-7222-8333-1234567890ef',
          timestamp: '2026-02-25T09:00:00.000Z',
          cwd: '/tmp/project-c',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hola desde la sesion' }],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  const message = await getLocalCodexSessionLastMessage(
    '019abcde-3333-7222-8333-1234567890ef',
    { sessionsDir, filePath }
  );
  assert.equal(message, 'Hola desde la sesion');
});

test('listLocalCodexSessions extracts displayName from first message text', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-codex-display-name-'));
  const sessionsDir = path.join(tmp, 'sessions');
  const filePath = path.join(
    sessionsDir,
    '2026/02/25/rollout-2026-02-25T10-00-00-019abcde-4444-7222-8333-1234567890aa.jsonl'
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        timestamp: '2026-02-25T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019abcde-4444-7222-8333-1234567890aa',
          timestamp: '2026-02-25T10:00:00.000Z',
          cwd: '/tmp/project-d',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          content: [{ type: 'input_text', text: 'Plan para integrar login con Apple' }],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  const sessions = await listLocalCodexSessions({ sessionsDir, limit: 5 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].displayName, 'Plan para integrar login con Apple');
});

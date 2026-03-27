const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createCodexDesktopExportService,
} = require('../../src/services/codex-desktop-export');

test('codex desktop export service lists saved projects with active roots first', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-codex-home-'));
  const codexHome = path.join(tempRoot, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, '.codex-global-state.json'),
    JSON.stringify({
      'active-workspace-roots': ['/repo/b'],
      'electron-saved-workspace-roots': ['/repo/a', '/repo/b', '/repo/c'],
      'electron-workspace-root-labels': {
        '/repo/b': 'Repo B',
      },
    }),
    'utf8'
  );

  const service = createCodexDesktopExportService({ codexHome });
  const projects = await service.listProjects();

  assert.deepEqual(
    projects.map((entry) => [entry.path, entry.active, entry.label]),
    [
      ['/repo/b', true, 'Repo B'],
      ['/repo/a', false, 'a'],
      ['/repo/c', false, 'c'],
    ]
  );
});

test('codex desktop export service promotes a forked rollout without changing the original backup', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-codex-home-'));
  const codexHome = path.join(tempRoot, '.codex');
  const sessionsRoot = path.join(codexHome, 'sessions', '2026', '03', '27');
  await fs.mkdir(sessionsRoot, { recursive: true });
  const rolloutPath = path.join(
    sessionsRoot,
    'rollout-2026-03-27T07-38-47-thread-forked.jsonl'
  );
  const firstLine = JSON.stringify({
    timestamp: '2026-03-27T06:38:49.160Z',
    type: 'session_meta',
    payload: {
      cwd: '/Users/antonio/Projects/antoniolg/aipal',
      id: 'thread-forked',
      originator: 'aipal',
      source: { custom: 'aipal' },
    },
  });
  await fs.writeFile(
    rolloutPath,
    `${firstLine}\n{"timestamp":"2026-03-27T06:39:00.000Z","type":"response_item","payload":{"type":"message"}}\n`,
    'utf8'
  );

  const service = createCodexDesktopExportService({ codexHome });
  const result = await service.promoteForkedThread({
    projectPath: '/Users/antonio/Projects/antoniolg/publisher',
    threadId: 'thread-forked',
  });

  assert.equal(result.rolloutPath, rolloutPath);
  const backupText = await fs.readFile(result.backupPath, 'utf8');
  assert.match(backupText, /"originator":"aipal"/);

  const rewritten = await fs.readFile(rolloutPath, 'utf8');
  const [rewrittenFirstLine, secondLine] = rewritten.split('\n');
  const payload = JSON.parse(rewrittenFirstLine).payload;
  assert.equal(payload.originator, 'Codex Desktop');
  assert.equal(payload.source, 'vscode');
  assert.equal(payload.cwd, '/Users/antonio/Projects/antoniolg/publisher');
  assert.match(secondLine, /response_item/);
});

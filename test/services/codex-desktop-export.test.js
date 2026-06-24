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

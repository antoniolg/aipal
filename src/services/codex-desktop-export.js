const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function uniquePaths(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function readPathLabelMap(state) {
  const labels = state?.['electron-workspace-root-labels'];
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    return {};
  }
  return labels;
}

function sortProjects(projects) {
  return [...projects].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

function createCodexDesktopExportService(options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const globalStatePath = options.globalStatePath || path.join(codexHome, '.codex-global-state.json');

  async function readGlobalState() {
    const raw = await fs.readFile(globalStatePath, 'utf8');
    return JSON.parse(raw);
  }

  async function listProjects() {
    const state = await readGlobalState();
    const saved = uniquePaths(state?.['electron-saved-workspace-roots'] || []);
    const activeSet = new Set(uniquePaths(state?.['active-workspace-roots'] || []));
    const labels = readPathLabelMap(state);
    return sortProjects(
      saved.map((projectPath) => ({
        active: activeSet.has(projectPath),
        label: String(labels[projectPath] || '').trim() || path.basename(projectPath) || projectPath,
        path: projectPath,
      }))
    );
  }

  return {
    listProjects,
  };
}

module.exports = {
  createCodexDesktopExportService,
};

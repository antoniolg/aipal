const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryService } = require('../../src/services/memory');

test('buildCodexAppThreadInstructions includes the Telegram output style once at thread level', async () => {
  const service = createMemoryService({
    appendMemoryEvent: async () => {},
    buildThreadBootstrap: async () => '',
    configPath: '/tmp/config.json',
    curateMemory: async () => ({ eventsProcessed: 0, bytes: 0 }),
    documentDir: '/tmp/documents',
    extractDocumentTokens: (value) => ({ cleanedText: value, documentPaths: [] }),
    extractImageTokens: (value) => ({ cleanedText: value, imagePaths: [] }),
    extractScheduleOnceTokens: (value) => ({ cleanedText: value, schedules: [], errors: [] }),
    getMemoryEventsSinceCurate: () => 0,
    imageDir: '/tmp/images',
    memoryCurateEvery: 100,
    memoryPath: '/tmp/memory.md',
    persistMemory: async (fn) => fn(),
    readMemory: async () => ({ exists: true, content: 'memory contents' }),
    readSoul: async () => ({ exists: true, content: 'soul contents' }),
    readTools: async () => ({ exists: true, content: 'tools contents' }),
    setMemoryEventsSinceCurate: () => {},
    soulPath: '/tmp/soul.md',
    toolsPath: '/tmp/tools.md',
  });

  const instructions = await service.buildCodexAppThreadInstructions();

  assert.match(
    instructions,
    /Output style for Telegram: keep the final answer as the final user-facing answer/
  );
  assert.match(instructions, /Soul \(soul\.md\):/);
  assert.match(instructions, /Tools \(tools\.md\):/);
  assert.match(instructions, /Memory \(memory\.md\):/);
});

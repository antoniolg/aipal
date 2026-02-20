function createMemoryService(options) {
  const {
    appendMemoryEvent,
    buildThreadBootstrap,
    configPath,
    curateMemory,
    documentDir,
    extractDocumentTokens,
    extractImageTokens,
    imageDir,
    memoryCurateEvery,
    memoryPath,
    persistMemory,
    readMemory,
    readSoul,
    readTools,
    soulPath,
    toolsPath,
    getMemoryEventsSinceCurate,
    setMemoryEventsSinceCurate,
  } = options;

  function extractMemoryText(response) {
    const { cleanedText: withoutImages } = extractImageTokens(response || '', imageDir);
    const { cleanedText } = extractDocumentTokens(withoutImages, documentDir);
    return String(cleanedText || '').trim();
  }

  function maybeAutoCurateMemory() {
    const nextCount = getMemoryEventsSinceCurate() + 1;
    setMemoryEventsSinceCurate(nextCount);
    if (nextCount < memoryCurateEvery) return;
    setMemoryEventsSinceCurate(0);

    persistMemory(async () => {
      try {
        const result = await curateMemory();
        console.info(
          `Auto-curated memory events=${result.eventsProcessed} bytes=${result.bytes}`
        );
      } catch (err) {
        console.warn('Auto memory curation failed:', err);
      }
    }).catch((err) => {
      console.warn('Failed to schedule auto memory curation:', err);
    });
  }

  async function captureMemoryEvent(event) {
    try {
      await appendMemoryEvent(event);
      maybeAutoCurateMemory();
    } catch (err) {
      console.warn('Failed to append memory event:', err);
    }
  }

  async function buildBootstrapContext(contextOptions = {}) {
    const { threadKey } = contextOptions;
    const soul = await readSoul();
    const tools = await readTools();
    const memory = await readMemory();
    const lines = [
      'Bootstrap config:',
      `Config JSON: ${configPath}`,
      `Soul file: ${soulPath}`,
      `Tools file: ${toolsPath}`,
      `Memory file: ${memoryPath}`,
    ];
    if (soul.exists && soul.content) {
      lines.push('Soul (soul.md):');
      lines.push(soul.content);
      lines.push('End of soul.');
    }
    if (tools.exists && tools.content) {
      lines.push('Tools (tools.md):');
      lines.push(tools.content);
      lines.push('End of tools.');
    }
    if (memory.exists && memory.content) {
      lines.push('Memory (memory.md):');
      lines.push(memory.content);
      lines.push('End of memory.');
    }
    if (threadKey) {
      const threadBootstrap = await buildThreadBootstrap(threadKey);
      if (threadBootstrap) {
        lines.push(threadBootstrap);
        lines.push('End of thread memory.');
      }
    }
    return lines.join('\n');
  }

  return {
    buildBootstrapContext,
    captureMemoryEvent,
    extractMemoryText,
    maybeAutoCurateMemory,
  };
}

module.exports = {
  createMemoryService,
};

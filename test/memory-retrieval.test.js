const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadModules(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const memoryStorePath = path.join(__dirname, '..', 'src', 'memory-store.js');
  const retrievalPath = path.join(__dirname, '..', 'src', 'memory-retrieval.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(memoryStorePath)];
  delete require.cache[require.resolve(retrievalPath)];
  const memoryStore = require(memoryStorePath);
  const retrieval = require(retrievalPath);
  return { memoryStore, retrieval };
}

test('searchMemory ranks same-thread and lexical matches first', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-retrieval-'));
  const { memoryStore, retrieval } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: '1:root:codex',
    chatId: '1',
    topicId: 'root',
    agentId: 'codex',
    role: 'user',
    text: 'Necesito mejorar el retrieval de memoria en Aipal',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: '2:root:codex',
    chatId: '2',
    topicId: 'root',
    agentId: 'codex',
    role: 'user',
    text: 'Tema no relacionado de cocina',
  });

  const hits = await retrieval.searchMemory({
    query: 'retrieval memoria aipal',
    chatId: '1',
    topicId: 'root',
    agentId: 'codex',
    limit: 5,
  });

  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /retrieval de memoria/i);
  assert.equal(hits[0].scope, 'same-thread');
});

test('buildMemoryRetrievalContext renders compact retrieval block', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-retrieval-'));
  const { memoryStore, retrieval } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: '55:topicA:codex',
    chatId: '55',
    topicId: 'topicA',
    agentId: 'codex',
    role: 'user',
    text: 'Decidimos usar curación al hacer reset',
  });

  const context = await retrieval.buildMemoryRetrievalContext({
    query: 'curación reset',
    chatId: '55',
    topicId: 'topicA',
    agentId: 'codex',
    limit: 3,
  });

  assert.match(context, /Relevant memory retrieved:/);
  assert.match(context, /same-thread/);
  assert.match(context, /curación al hacer reset/i);
});

test('searchMemory includes global context when available', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-retrieval-'));
  const { memoryStore, retrieval } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: '10:topicA:codex',
    chatId: '10',
    topicId: 'topicA',
    agentId: 'codex',
    role: 'user',
    text: 'Necesito mejorar el memory retrieval de Aipal',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: '10:topicA:codex',
    chatId: '10',
    topicId: 'topicA',
    agentId: 'codex',
    role: 'assistant',
    text: 'Podemos hacer curación automática de memoria',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: '10:topicA:codex',
    chatId: '10',
    topicId: 'topicA',
    agentId: 'codex',
    role: 'user',
    text: 'También quiero que el retrieval sea práctico',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: '20:topicB:codex',
    chatId: '20',
    topicId: 'topicB',
    agentId: 'codex',
    role: 'user',
    text: 'Objetivo: cerebro global entre topics con retrieval',
  });

  const hits = await retrieval.searchMemory({
    query: 'retrieval cerebro global',
    chatId: '10',
    topicId: 'topicA',
    agentId: 'codex',
    limit: 8,
  });

  assert.ok(hits.length >= 2);
  assert.ok(hits.some((hit) => hit.scope === 'global'));
});

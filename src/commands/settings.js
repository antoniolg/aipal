const fs = require('fs/promises');
const path = require('path');

const SESSION_LIMIT_DEFAULT = 10;
const SESSION_LIMIT_MAX = 30;
const PROJECT_LIMIT_DEFAULT = 12;
const PROJECT_LIMIT_MAX = 20;
const PROJECT_PICKER_TTL_MS = 30 * 60 * 1000;
const MENU_PICKER_TTL_MS = 30 * 60 * 1000;
const MENU_SESSION_LIST_LIMIT = 12;
const MENU_SESSION_NAV_LIMIT = 3;
const MENU_NAV_TTL_MS = 30 * 60 * 1000;
const MENU_PROJECT_PAGE_SIZE = 8;
const MENU_SESSION_PAGE_SIZE = 6;
const MENU_SEARCH_MAX_RESULTS = 200;

const MENU_BTN_PROJECT = 'Project';
const MENU_BTN_SESSIONS = 'Sesiones';
const MENU_BTN_RESUME_LAST = 'Reanudar última';
const MENU_BTN_SEARCH = 'Buscar';
const MENU_BTN_PREV = 'Anterior';
const MENU_BTN_NEXT = 'Siguiente';
const MENU_BTN_BACK = 'Volver';
const MENU_BTN_NEW_SESSION = 'Nueva sesión';
const MENU_BTN_HIDE_KEYBOARD = 'Ocultar teclado';

const projectPickerCache = new Map();
const menuProjectCache = new Map();
const menuSessionCache = new Map();
const menuNavCache = new Map();

function parseSessionLimit(value) {
  const parsed = Number.parseInt(String(value || SESSION_LIMIT_DEFAULT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return SESSION_LIMIT_DEFAULT;
  return Math.min(parsed, SESSION_LIMIT_MAX);
}

function parseProjectLimit(value) {
  const parsed = Number.parseInt(String(value || PROJECT_LIMIT_DEFAULT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PROJECT_LIMIT_DEFAULT;
  return Math.min(parsed, PROJECT_LIMIT_MAX);
}

function shortSessionId(value) {
  const id = String(value || '');
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function formatSessionLine(session) {
  const when = String(session.timestamp || '').replace('T', ' ').replace('Z', '');
  return `- ${sessionDisplayLabel(session)} | ${when}`;
}

function sanitizeButtonText(value, max = 60) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function sessionDisplayLabel(session) {
  const cwd = String(session?.cwd || '').trim();
  if (!cwd) return shortSessionId(session?.id);
  const project = path.basename(cwd) || cwd;
  return `${project} (${shortSessionId(session?.id)})`;
}

function projectDisplayLabel(project) {
  const base = path.basename(project.cwd) || project.cwd;
  return `${base} (${project.sessionsCount})`;
}

function projectNameFromCwd(cwd) {
  const normalized = String(cwd || '').trim();
  if (!normalized) return '(proyecto desconocido)';
  return path.basename(normalized) || normalized;
}

function buildSessionButtons(sessions) {
  return sessions.map((session) => {
    const label = sanitizeButtonText(sessionDisplayLabel(session));
    return [
      {
        text: label,
        callback_data: `session_attach:${session.id}`,
      },
    ];
  });
}

function buildProjectButtons(token, projects) {
  return projects.map((project, index) => [
    {
      text: sanitizeButtonText(projectDisplayLabel(project)),
      callback_data: `project_open:${token}:${index}`,
    },
  ]);
}

function buildProjectListFromSessions(sessions) {
  const grouped = new Map();
  for (const session of sessions) {
    const cwd = String(session.cwd || '').trim();
    if (!cwd) continue;
    const existing = grouped.get(cwd);
    if (!existing) {
      grouped.set(cwd, {
        cwd,
        latestTimestamp: session.timestamp || '',
        latestSessionId: session.id,
        sessionsCount: 1,
      });
      continue;
    }
    existing.sessionsCount += 1;
    if (String(session.timestamp || '') > String(existing.latestTimestamp || '')) {
      existing.latestTimestamp = session.timestamp || '';
      existing.latestSessionId = session.id;
    }
  }
  return [...grouped.values()].sort((a, b) =>
    String(b.latestTimestamp || '').localeCompare(String(a.latestTimestamp || ''))
  );
}

function cleanupProjectPickerCache() {
  const now = Date.now();
  for (const [key, value] of projectPickerCache.entries()) {
    if (!value?.createdAt || now - value.createdAt > PROJECT_PICKER_TTL_MS) {
      projectPickerCache.delete(key);
    }
  }
}

function cleanupMenuCaches() {
  const now = Date.now();
  for (const [key, value] of menuProjectCache.entries()) {
    if (!value?.createdAt || now - value.createdAt > MENU_PICKER_TTL_MS) {
      menuProjectCache.delete(key);
    }
  }
  for (const [key, value] of menuSessionCache.entries()) {
    if (!value?.createdAt || now - value.createdAt > MENU_PICKER_TTL_MS) {
      menuSessionCache.delete(key);
    }
  }
}

function createPickerToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatShortWhen(timestamp) {
  const raw = String(timestamp || '').trim();
  if (!raw) return '';
  return raw.replace('T', ' ').replace('Z', '').slice(0, 16);
}

function menuNavKeyFromIds(chatId, topicId) {
  const normalizedTopic =
    topicId === undefined || topicId === null || topicId === ''
      ? 'root'
      : String(topicId);
  return `${chatId}:${normalizedTopic}`;
}

function cleanupMenuNavCache() {
  const now = Date.now();
  for (const [key, value] of menuNavCache.entries()) {
    if (!value?.createdAt || now - value.createdAt > MENU_NAV_TTL_MS) {
      menuNavCache.delete(key);
    }
  }
}

function uniqueMenuLabel(base, usedLabels) {
  const trimmed = sanitizeButtonText(base, 44);
  if (!usedLabels.has(trimmed)) {
    usedLabels.add(trimmed);
    return trimmed;
  }
  let i = 2;
  while (true) {
    const candidate = sanitizeButtonText(`${trimmed} (${i})`, 44);
    if (!usedLabels.has(candidate)) {
      usedLabels.add(candidate);
      return candidate;
    }
    i += 1;
  }
}

function buildProjectMenuEntries(projects) {
  const used = new Set();
  return projects.map((project) => {
    const name = projectNameFromCwd(project.cwd);
    return {
      label: uniqueMenuLabel(name, used),
      project,
    };
  });
}

function buildSessionMenuEntries(sessions) {
  const used = new Set();
  return sessions.map((session, index) => {
    const when = formatShortWhen(session.timestamp);
    const rawName = String(session?.displayName || '').trim();
    const baseName = rawName || `Sesión ${index + 1}`;
    const base = when ? `${baseName} · ${when}` : baseName;
    return {
      label: uniqueMenuLabel(base, used),
      session,
    };
  });
}

function buildMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BTN_PROJECT }, { text: MENU_BTN_SESSIONS }],
      [{ text: MENU_BTN_RESUME_LAST }],
      [{ text: MENU_BTN_HIDE_KEYBOARD }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getPagedEntries(entries, page, pageSize) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const totalPages = Math.max(1, Math.ceil(safeEntries.length / pageSize));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const start = safePage * pageSize;
  const end = start + pageSize;
  return {
    pageEntries: safeEntries.slice(start, end),
    page: safePage,
    totalPages,
    totalItems: safeEntries.length,
  };
}

function buildProjectsMenuKeyboard(projectEntries, page = 0) {
  const paged = getPagedEntries(projectEntries, page, MENU_PROJECT_PAGE_SIZE);
  const navRow = [];
  if (paged.page > 0) navRow.push({ text: MENU_BTN_PREV });
  if (paged.page < paged.totalPages - 1) navRow.push({ text: MENU_BTN_NEXT });

  return {
    keyboard: [
      ...paged.pageEntries.map((entry) => [{ text: entry.label }]),
      [{ text: MENU_BTN_SEARCH }],
      ...(navRow.length ? [navRow] : []),
      [{ text: MENU_BTN_BACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildSessionsMenuKeyboard(sessionEntries, page = 0) {
  const paged = getPagedEntries(sessionEntries, page, MENU_SESSION_PAGE_SIZE);
  const navRow = [];
  if (paged.page > 0) navRow.push({ text: MENU_BTN_PREV });
  if (paged.page < paged.totalPages - 1) navRow.push({ text: MENU_BTN_NEXT });

  return {
    keyboard: [
      ...paged.pageEntries.map((entry) => [{ text: entry.label }]),
      [{ text: MENU_BTN_SEARCH }],
      ...(navRow.length ? [navRow] : []),
      [{ text: MENU_BTN_NEW_SESSION }],
      [{ text: MENU_BTN_BACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildMainMenuButtons() {
  return [
    [
      { text: 'Proyectos', callback_data: 'menu_projects' },
      { text: 'Sesiones', callback_data: 'menu_sessions' },
    ],
  ];
}

function buildPersistentKeyboard() {
  return buildMainMenuKeyboard();
}

function buildMenuProjectButtons(token, projects) {
  return [
    ...projects.map((project, index) => [
      {
        text: sanitizeButtonText(projectDisplayLabel(project)),
        callback_data: `menu_project:${token}:${index}`,
      },
    ]),
    [{ text: 'Volver', callback_data: 'menu_main' }],
  ];
}

function buildMenuSessionButtons(token, sessions, includeBack = true) {
  const buttons = sessions.map((session, index) => [
    {
      text: sanitizeButtonText(sessionDisplayLabel(session)),
      callback_data: `menu_session_attach:${token}:${index}`,
    },
  ]);
  if (includeBack) {
    buttons.push([{ text: 'Volver', callback_data: 'menu_main' }]);
  }
  return buttons;
}

function registerSettingsCommands(options) {
  const {
    allowedUsers,
    bot,
    buildTopicKey,
    clearAgentOverride,
    clearModelOverride,
    clearThreadForAgent,
    curateMemory,
    execLocal,
    extractCommandValue,
    getAgent,
    getAgentLabel,
    getAgentOverride,
    getGlobalAgent,
    getGlobalAgentCwd,
    getGlobalModels,
    getGlobalThinking,
    getThreads,
    getLocalCodexSessionLastMessage,
    getTopicId,
    isKnownAgent,
    isModelResetCommand,
    normalizeAgent,
    normalizeTopicId,
    resolveThreadId,
    persistAgentOverrides,
    persistMemory,
    persistThreads,
    listLocalCodexSessions,
    replyWithError,
    setAgentOverride,
    setGlobalAgent,
    setGlobalAgentCwd,
    setGlobalModels,
    setGlobalThinking,
    setMemoryEventsSinceCurate,
    setThreadForAgent,
    startTyping,
    threadTurns,
    updateConfig,
    wrapCommandWithPty,
    isValidSessionId,
  } = options;

  function canUseSensitiveCommands() {
    return allowedUsers instanceof Set && allowedUsers.size > 0;
  }

  async function denySensitiveCommand(ctx) {
    await ctx.reply(
      'Este comando requiere configurar ALLOWED_USERS para evitar exponer rutas locales.'
    );
  }

  async function denySensitiveAction(ctx) {
    await ctx.answerCbQuery(
      'Configura ALLOWED_USERS para usar esta funcion.',
      { show_alert: true }
    );
  }

  function effectiveAgentFor(chatId, topicId) {
    return getAgentOverride(chatId, topicId) || getGlobalAgent();
  }

  async function replyMainMenu(ctx) {
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (chatId) {
      const key = menuNavKeyFromIds(chatId, topicId);
      menuNavCache.set(key, {
        createdAt: Date.now(),
        level: 'main',
      });
    }
    await ctx.reply('Menú principal:', {
      reply_markup: buildMainMenuKeyboard(),
    });
  }

  async function showPersistentKeyboard(ctx) {
    await ctx.reply('Atajos activados en teclado.', {
      reply_markup: buildPersistentKeyboard(),
    });
  }

  async function showProjectsKeyboardMenu(ctx) {
    cleanupMenuNavCache();
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const sessions = await listLocalCodexSessions({ limit: 300 });
    const projects = buildProjectListFromSessions(sessions).slice(0, PROJECT_LIMIT_MAX);
    if (!projects.length) {
      await ctx.reply('No encontré proyectos locales en sesiones de Codex.');
      return;
    }

    const projectEntries = buildProjectMenuEntries(projects);
    const key = menuNavKeyFromIds(chatId, topicId);
    menuNavCache.set(key, {
      createdAt: Date.now(),
      level: 'projects',
      projectEntries,
      filteredProjectEntries: projectEntries,
      page: 0,
      query: '',
    });

    const paged = getPagedEntries(projectEntries, 0, MENU_PROJECT_PAGE_SIZE);
    await ctx.reply(
      `Selecciona un proyecto (${paged.totalItems}) · página ${paged.page + 1}/${paged.totalPages}:`,
      {
        reply_markup: buildProjectsMenuKeyboard(projectEntries, 0),
      }
    );
  }

  async function renderProjectsPage(ctx, state) {
    const filtered = Array.isArray(state?.filteredProjectEntries)
      ? state.filteredProjectEntries
      : [];
    const page = Number(state?.page) || 0;
    const paged = getPagedEntries(filtered, page, MENU_PROJECT_PAGE_SIZE);
    const queryPart = state?.query ? ` · filtro: "${state.query}"` : '';
    await ctx.reply(
      `Selecciona un proyecto (${paged.totalItems})${queryPart} · página ${paged.page + 1}/${paged.totalPages}:`,
      {
        reply_markup: buildProjectsMenuKeyboard(filtered, paged.page),
      }
    );
  }

  async function renderSessionsPage(ctx, state) {
    const entries = Array.isArray(state?.filteredSessionEntries)
      ? state.filteredSessionEntries
      : [];
    const page = Number(state?.page) || 0;
    const paged = getPagedEntries(entries, page, MENU_SESSION_PAGE_SIZE);
    const queryPart = state?.query ? ` · filtro: "${state.query}"` : '';
    const header = state?.project?.cwd
      ? `Proyecto: ${projectNameFromCwd(state.project.cwd)}`
      : 'Sesiones recientes del proyecto activo';
    const subtitle = paged.totalItems
      ? `Selecciona sesión o crea una nueva (${paged.totalItems})${queryPart} · página ${paged.page + 1}/${paged.totalPages}.`
      : `No hay sesiones en esta vista${queryPart}. Puedes crear una nueva o volver.`;
    await ctx.reply([header, subtitle].join('\n'), {
      reply_markup: buildSessionsMenuKeyboard(entries, paged.page),
    });
  }

  function filterByQuery(entries, query) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return Array.isArray(entries) ? entries : [];
    return (Array.isArray(entries) ? entries : []).filter((entry) => {
      const label = String(entry?.label || '').toLowerCase();
      const cwd = String(entry?.project?.cwd || entry?.session?.cwd || '').toLowerCase();
      const id = String(entry?.session?.id || entry?.project?.latestSessionId || '').toLowerCase();
      return label.includes(q) || cwd.includes(q) || id.includes(q);
    });
  }

  function updateSearchState(baseState, query) {
    const q = String(query || '').trim();
    if (baseState.level === 'projects') {
      const source = Array.isArray(baseState.projectEntries) ? baseState.projectEntries : [];
      const filteredProjectEntries = filterByQuery(source, q).slice(0, MENU_SEARCH_MAX_RESULTS);
      return {
        ...baseState,
        query: q,
        page: 0,
        filteredProjectEntries,
        awaitingSearch: false,
      };
    }
    if (baseState.level === 'project_sessions' || baseState.level === 'sessions') {
      const source = Array.isArray(baseState.sessionEntries) ? baseState.sessionEntries : [];
      const filteredSessionEntries = filterByQuery(source, q).slice(0, MENU_SEARCH_MAX_RESULTS);
      return {
        ...baseState,
        query: q,
        page: 0,
        filteredSessionEntries,
        awaitingSearch: false,
      };
    }
    return {
      ...baseState,
      awaitingSearch: false,
    };
  }

  function setAwaitingSearch(baseState) {
    if (!baseState) return baseState;
    if (
      baseState.level !== 'projects' &&
      baseState.level !== 'project_sessions' &&
      baseState.level !== 'sessions'
    ) {
      return baseState;
    }
    return {
      ...baseState,
      awaitingSearch: true,
    };
  }

  async function showResumeLast(ctx) {
    const chatId = ctx?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;
    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }
    const threads = typeof getThreads === 'function' ? getThreads() : null;
    if (!threads || typeof resolveThreadId !== 'function') {
      await ctx.reply('No pude leer la última sesión ahora.');
      return;
    }
    const resolved = resolveThreadId(threads, chatId, topicId, effectiveAgentId);
    const sessionId = String(resolved?.threadId || '').trim();
    if (!sessionId || !isValidSessionId(sessionId)) {
      await ctx.reply('No hay una sesión previa para reanudar en este tópico.');
      return;
    }
    setThreadForAgent(chatId, topicId, effectiveAgentId, sessionId);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after resuming last session:', err)
    );
    await ctx.reply(`Sesión reanudada: ${sessionId}`, {
      reply_markup: {
        remove_keyboard: true,
      },
    });
  }

  async function showSessionsForProjectKeyboardMenu(ctx, project) {
    cleanupMenuNavCache();
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const cwd = String(project?.cwd || '').trim();
    if (!cwd) {
      await ctx.reply('No pude resolver el proyecto seleccionado.');
      return;
    }
    setGlobalAgentCwd(cwd);
    try {
      await updateConfig({ agentCwd: cwd });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude guardar el proyecto activo.', err);
      return;
    }

    const sessions = await listLocalCodexSessions({
      limit: MENU_SEARCH_MAX_RESULTS,
      cwd,
    });
    const sessionEntries = buildSessionMenuEntries(sessions);
    const key = menuNavKeyFromIds(chatId, topicId);
    const previousState = menuNavCache.get(key);
    menuNavCache.set(key, {
      createdAt: Date.now(),
      level: 'project_sessions',
      project,
      projectEntries: Array.isArray(previousState?.projectEntries)
        ? previousState.projectEntries
        : [],
      filteredProjectEntries: Array.isArray(previousState?.filteredProjectEntries)
        ? previousState.filteredProjectEntries
        : Array.isArray(previousState?.projectEntries)
          ? previousState.projectEntries
          : [],
      projectPage: Number(previousState?.page) || 0,
      projectQuery: String(previousState?.query || ''),
      sessionEntries,
      filteredSessionEntries: sessionEntries,
      page: 0,
      query: '',
    });
    await renderSessionsPage(ctx, menuNavCache.get(key));
  }

  async function showRecentSessionsKeyboardMenu(ctx) {
    cleanupMenuNavCache();
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const cwd = getGlobalAgentCwd();
    const sessions = await listLocalCodexSessions({
      limit: MENU_SEARCH_MAX_RESULTS,
      cwd,
    });
    const sessionEntries = buildSessionMenuEntries(sessions);
    const key = menuNavKeyFromIds(chatId, topicId);
    menuNavCache.set(key, {
      createdAt: Date.now(),
      level: 'sessions',
      sessionEntries,
      filteredSessionEntries: sessionEntries,
      cwd,
      page: 0,
      query: '',
    });
    await renderSessionsPage(ctx, menuNavCache.get(key));
  }

  bot.command('thinking', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    if (!value) {
      if (getGlobalThinking()) {
        ctx.reply(`Current reasoning effort: ${getGlobalThinking()}`);
      } else {
        ctx.reply('No reasoning effort set. Use /thinking <level>.');
      }
      return;
    }
    try {
      setGlobalThinking(value);
      ctx.reply(`Reasoning effort set to ${value}.`);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to update reasoning effort.', err);
    }
  });

  bot.command('agent', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const topicId = getTopicId(ctx);
    const normalizedTopic = normalizeTopicId(topicId);

    if (!value) {
      const effective =
        getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
      ctx.reply(
        `Current agent (${normalizedTopic}): ${getAgentLabel(
          effective
        )}. Use /agent <name> or /agent default.`
      );
      return;
    }

    if (value === 'default') {
      if (normalizedTopic === 'root') {
        ctx.reply('Already using global agent in root topic.');
        return;
      }
      clearAgentOverride(ctx.chat.id, topicId);
      persistAgentOverrides().catch((err) =>
        console.warn('Failed to persist agent overrides:', err)
      );
      ctx.reply(
        `Agent override cleared for ${normalizedTopic}. Now using ${getAgentLabel(
          getGlobalAgent()
        )}.`
      );
      return;
    }

    if (!isKnownAgent(value)) {
      ctx.reply('Unknown agent. Use /agent codex|claude|gemini|opencode.');
      return;
    }

    const normalizedAgent = normalizeAgent(value);
    if (normalizedTopic === 'root') {
      setGlobalAgent(normalizedAgent);
      try {
        await updateConfig({ agent: normalizedAgent });
        ctx.reply(`Global agent set to ${getAgentLabel(getGlobalAgent())}.`);
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'Failed to persist global agent setting.', err);
      }
    } else {
      setAgentOverride(ctx.chat.id, topicId, normalizedAgent);
      persistAgentOverrides().catch((err) =>
        console.warn('Failed to persist agent overrides:', err)
      );
      ctx.reply(`Agent for this topic set to ${getAgentLabel(normalizedAgent)}.`);
    }
  });

  bot.command('reset', async (ctx) => {
    const topicId = getTopicId(ctx);
    const effectiveAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
    clearThreadForAgent(ctx.chat.id, topicId, effectiveAgentId);
    threadTurns.delete(`${buildTopicKey(ctx.chat.id, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after reset:', err)
    );
    try {
      await persistMemory(() => curateMemory());
      setMemoryEventsSinceCurate(0);
      await ctx.reply(
        `Session reset for ${getAgentLabel(
          effectiveAgentId
        )} in this topic. Memory curated.`
      );
    } catch (err) {
      console.warn('Failed to curate memory on reset:', err);
      await ctx.reply(
        `Session reset for ${getAgentLabel(
          effectiveAgentId
        )} in this topic. Memory curation failed.`
      );
    }
  });

  bot.command('model', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const currentAgentId = getGlobalAgent();
    const agent = getAgent(currentAgentId);

    if (!value) {
      const current = getGlobalModels()[currentAgentId] || agent.defaultModel || '(default)';
      let msg = `Current model for ${agent.label}: ${current}. Use /model <model_id> to change or /model reset to clear.`;

      if (typeof agent.listModelsCommand === 'function') {
        const stopTyping = startTyping(ctx);
        try {
          const cmd = agent.listModelsCommand();
          let cmdToRun = cmd;
          if (agent.needsPty) cmdToRun = wrapCommandWithPty(cmdToRun);

          const output = await execLocal('bash', ['-lc', cmdToRun], {
            timeout: 30000,
          });

          let modelsList = output.trim();
          if (typeof agent.parseModelList === 'function') {
            modelsList = agent.parseModelList(modelsList);
          }

          if (modelsList) {
            msg += `\n\nAvailable models:\n${modelsList}`;
          }
          stopTyping();
        } catch (err) {
          msg += `\n(Failed to list models: ${err.message})`;
          stopTyping();
        }
      }

      ctx.reply(msg);
      return;
    }

    try {
      if (isModelResetCommand(value)) {
        const { nextModels, hadOverride } = clearModelOverride(
          getGlobalModels(),
          currentAgentId
        );
        setGlobalModels(nextModels);
        await updateConfig({ models: getGlobalModels() });
        if (hadOverride) {
          const current = agent.defaultModel || '(default)';
          ctx.reply(`Model for ${agent.label} reset. Now using ${current}.`);
        } else {
          ctx.reply(`No model override set for ${agent.label}.`);
        }
        return;
      }

      const nextModels = { ...getGlobalModels(), [currentAgentId]: value };
      setGlobalModels(nextModels);
      await updateConfig({ models: getGlobalModels() });

      ctx.reply(`Model for ${agent.label} set to ${value}.`);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to persist model setting.', err);
    }
  });

  bot.command('project', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    const value = extractCommandValue(ctx.message.text);
    if (!value) {
      const current = getGlobalAgentCwd();
      if (current) {
        await ctx.reply(`Proyecto activo: ${projectNameFromCwd(current)}`);
      } else {
        await ctx.reply(
          'No hay proyecto activo. Usa /project /absolute/path/to/project.'
        );
      }
      return;
    }

    if (value === 'reset' || value === 'default') {
      setGlobalAgentCwd('');
      try {
        await updateConfig({ agentCwd: null });
        await ctx.reply('Proyecto reseteado. El bot vuelve al directorio de arranque.');
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'Failed to reset project path.', err);
      }
      return;
    }

    const resolved = path.resolve(value);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        await ctx.reply('La ruta no es un directorio valido.');
        return;
      }
      setGlobalAgentCwd(resolved);
      await updateConfig({ agentCwd: resolved });
      await ctx.reply(`Proyecto activo: ${projectNameFromCwd(resolved)}`);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await ctx.reply('La ruta no existe.');
        return;
      }
      console.error(err);
      await replyWithError(ctx, 'Failed to set project path.', err);
    }
  });

  bot.command('sessions', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    const topicId = getTopicId(ctx);
    const effectiveAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('`/sessions` is only available when using codex. Use /agent codex.');
      return;
    }

    const rawValue = extractCommandValue(ctx.message.text);
    const limit = parseSessionLimit(rawValue);
    const cwd = getGlobalAgentCwd();
    try {
      const sessions = await listLocalCodexSessions({ limit, cwd });
      if (!sessions.length) {
        const suffix = cwd ? ` para proyecto ${projectNameFromCwd(cwd)}` : '';
        await ctx.reply(`No local Codex sessions found${suffix}.`);
        return;
      }
      const lines = sessions.map(formatSessionLine);
      const header = cwd
        ? `Recent Codex sessions for ${projectNameFromCwd(cwd)}:`
        : 'Recent Codex sessions:';
      await ctx.reply([header, ...lines, '', 'Tap a button to attach a session.'].join('\n'), {
        reply_markup: {
          inline_keyboard: buildSessionButtons(sessions),
        },
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to list local Codex sessions.', err);
    }
  });

  bot.command('projects', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupProjectPickerCache();
    const topicId = getTopicId(ctx);
    const effectiveAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('`/projects` is only available when using codex. Use /agent codex.');
      return;
    }

    const rawValue = extractCommandValue(ctx.message.text);
    const limit = parseProjectLimit(rawValue);
    try {
      const sessions = await listLocalCodexSessions({ limit: 300 });
      const projects = buildProjectListFromSessions(sessions).slice(0, limit);
      if (!projects.length) {
        await ctx.reply('No local Codex projects found in sessions.');
        return;
      }
      const lines = projects.map(
        (project) =>
          `- ${projectDisplayLabel(project)} | latest: ${shortSessionId(
            project.latestSessionId
          )}`
      );
      const pickerToken = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const sent = await ctx.reply(
        ['Recent projects from local Codex sessions:', ...lines, '', 'Tap a project to open latest session in it.'].join('\n'),
        {
          reply_markup: {
            inline_keyboard: buildProjectButtons(pickerToken, projects),
          },
        }
      );
      const key = `${ctx.chat.id}:${pickerToken}`;
      projectPickerCache.set(key, {
        createdAt: Date.now(),
        messageId: sent.message_id,
        projects,
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to list local Codex projects.', err);
    }
  });

  bot.command('menu', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    await replyMainMenu(ctx);
  });

  bot.hears(/^ocultar teclado$/i, async (ctx) => {
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    menuNavCache.delete(key);
    await ctx.reply('Teclado oculto. Escribe /menu para volver a mostrarlo.', {
      reply_markup: {
        remove_keyboard: true,
      },
    });
  });

  bot.hears(/^project$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    try {
      await showProjectsKeyboardMenu(ctx);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude abrir proyectos del menú.', err);
    }
  });

  bot.hears(/^sesiones$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    try {
      await showRecentSessionsKeyboardMenu(ctx);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude abrir sesiones del menú.', err);
    }
  });

  bot.hears(/^reanudar última$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    try {
      await showResumeLast(ctx);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude reanudar la última sesión.', err);
    }
  });

  bot.hears(/^volver$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    const state = menuNavCache.get(key);
    if (!state || state.level === 'main') {
      await replyMainMenu(ctx);
      return;
    }
    if (state.level === 'project_sessions') {
      const previous = {
        createdAt: Date.now(),
        level: 'projects',
        projectEntries: Array.isArray(state.projectEntries)
          ? state.projectEntries
          : [],
        filteredProjectEntries: Array.isArray(state.filteredProjectEntries)
          ? state.filteredProjectEntries
          : Array.isArray(state.projectEntries)
            ? state.projectEntries
          : [],
        page: Number(state.projectPage) || 0,
        query: String(state.projectQuery || ''),
      };
      if (!Array.isArray(previous.projectEntries) || !previous.projectEntries.length) {
        try {
          await showProjectsKeyboardMenu(ctx);
        } catch (err) {
          console.error(err);
          await replyWithError(ctx, 'No pude volver a la lista de proyectos.', err);
        }
        return;
      }
      menuNavCache.set(key, previous);
      await renderProjectsPage(ctx, previous);
      return;
    }
    await replyMainMenu(ctx);
  });

  bot.hears(/^buscar$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    const state = menuNavCache.get(key);
    const nextState = setAwaitingSearch(state);
    if (!nextState || nextState === state) return;
    menuNavCache.set(key, nextState);
    await ctx.reply('Escribe el texto a buscar. Para limpiar filtro escribe: limpiar');
  });

  bot.hears(/^anterior$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    const state = menuNavCache.get(key);
    if (!state) return;

    if (state.level === 'projects') {
      const total = getPagedEntries(
        state.filteredProjectEntries || [],
        state.page || 0,
        MENU_PROJECT_PAGE_SIZE
      );
      const next = { ...state, page: Math.max(0, total.page - 1) };
      menuNavCache.set(key, next);
      await renderProjectsPage(ctx, next);
      return;
    }
    if (state.level === 'project_sessions' || state.level === 'sessions') {
      const total = getPagedEntries(
        state.filteredSessionEntries || [],
        state.page || 0,
        MENU_SESSION_PAGE_SIZE
      );
      const next = { ...state, page: Math.max(0, total.page - 1) };
      menuNavCache.set(key, next);
      await renderSessionsPage(ctx, next);
    }
  });

  bot.hears(/^siguiente$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    const state = menuNavCache.get(key);
    if (!state) return;

    if (state.level === 'projects') {
      const current = getPagedEntries(
        state.filteredProjectEntries || [],
        state.page || 0,
        MENU_PROJECT_PAGE_SIZE
      );
      const next = { ...state, page: Math.min(current.totalPages - 1, current.page + 1) };
      menuNavCache.set(key, next);
      await renderProjectsPage(ctx, next);
      return;
    }
    if (state.level === 'project_sessions' || state.level === 'sessions') {
      const current = getPagedEntries(
        state.filteredSessionEntries || [],
        state.page || 0,
        MENU_SESSION_PAGE_SIZE
      );
      const next = { ...state, page: Math.min(current.totalPages - 1, current.page + 1) };
      menuNavCache.set(key, next);
      await renderSessionsPage(ctx, next);
    }
  });

  bot.hears(/^nueva sesión$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const key = menuNavKeyFromIds(chatId, topicId);
    const state = menuNavCache.get(key);
    if (!state || (state.level !== 'project_sessions' && state.level !== 'sessions')) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const cwd = String(state.project?.cwd || state.cwd || '').trim();
    if (!cwd) {
      await ctx.reply('No pude resolver el proyecto. Vuelve a /menu.');
      return;
    }

    setGlobalAgentCwd(cwd);
    clearThreadForAgent(chatId, topicId, effectiveAgentId);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after new session selection:', err)
    );

    try {
      await updateConfig({ agentCwd: cwd });
      await ctx.reply(
        `Proyecto activo: ${projectNameFromCwd(
          cwd
        )}\nSe creó una sesión nueva para este tópico.`,
        {
          reply_markup: {
            remove_keyboard: true,
          },
        }
      );
      menuNavCache.set(key, {
        createdAt: Date.now(),
        level: 'main',
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude guardar el proyecto.', err);
    }
  });

  bot.hears(/^.+$/, async (ctx, next) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const key = menuNavKeyFromIds(chatId, topicId);
    const state = menuNavCache.get(key);
    const selectedLabel = String(ctx.message?.text || '').trim();
    if (!state) return next();

    if (state.level === 'projects') {
      const selectedEntry = (state.filteredProjectEntries || []).find(
        (entry) => entry.label === selectedLabel
      );
      if (!selectedEntry) return next();
      try {
        await showSessionsForProjectKeyboardMenu(ctx, selectedEntry.project);
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'No pude cargar sesiones del proyecto.', err);
      }
      return;
    }

    if (state.level !== 'project_sessions' && state.level !== 'sessions') return next();

    const selectedEntry = (state.filteredSessionEntries || []).find(
      (entry) => entry.label === selectedLabel
    );
    if (!selectedEntry || !isValidSessionId(selectedEntry.session.id)) return next();

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const selected = selectedEntry.session;
    const cwd = String(selected.cwd || state.project?.cwd || state.cwd || '').trim();
    if (cwd) {
      setGlobalAgentCwd(cwd);
      try {
        await updateConfig({ agentCwd: cwd });
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'No pude guardar el proyecto.', err);
        return;
      }
    }

    setThreadForAgent(chatId, topicId, effectiveAgentId, selected.id);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after session attach from keyboard menu:', err)
    );

    let preview = '';
    try {
      preview = await getLocalCodexSessionLastMessage(selected.id, {
        filePath: selected.filePath,
      });
    } catch (err) {
      console.warn('Failed to get session preview:', err);
    }

    const lines = [`Sesión conectada: ${selected.id}`];
    if (cwd) lines.push(`Proyecto activo: ${projectNameFromCwd(cwd)}`);
    if (preview) lines.push(`Último mensaje: ${preview.slice(0, 240)}`);
    await ctx.reply(lines.join('\n'), {
      reply_markup: {
        remove_keyboard: true,
      },
    });
    menuNavCache.set(key, {
      createdAt: Date.now(),
      level: 'main',
    });
    return;
  });

  bot.on('text', async (ctx, next) => {
    cleanupMenuNavCache();
    const key = menuNavKeyFromIds(ctx.chat.id, getTopicId(ctx));
    const state = menuNavCache.get(key);
    if (!state?.awaitingSearch) {
      return next();
    }

    const text = String(ctx.message?.text || '').trim();
    if (!text || text.startsWith('/')) {
      const restored = { ...state, awaitingSearch: false };
      menuNavCache.set(key, restored);
      return next();
    }

    const query = /^limpiar$/i.test(text) ? '' : text;
    const updated = updateSearchState(
      {
        ...state,
        createdAt: Date.now(),
      },
      query
    );
    menuNavCache.set(key, updated);
    if (updated.level === 'projects') {
      await renderProjectsPage(ctx, updated);
      return;
    }
    if (updated.level === 'project_sessions' || updated.level === 'sessions') {
      await renderSessionsPage(ctx, updated);
      return;
    }
    return next();
  });

  bot.action('menu_main', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    await ctx.answerCbQuery();
    await replyMainMenu(ctx);
  });

  bot.action('menu_projects', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupMenuCaches();
    const chatId = ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id;
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!chatId) {
      await ctx.answerCbQuery('No pude resolver el chat.', { show_alert: true });
      return;
    }
    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Usa /agent codex primero.', { show_alert: true });
      return;
    }

    const sessions = await listLocalCodexSessions({ limit: 300 });
    const projects = buildProjectListFromSessions(sessions).slice(0, PROJECT_LIMIT_MAX);
    if (!projects.length) {
      await ctx.answerCbQuery();
      await ctx.reply('No encontré proyectos locales en sesiones de Codex.');
      return;
    }

    const token = createPickerToken();
    menuProjectCache.set(`${chatId}:${token}`, {
      createdAt: Date.now(),
      projects,
    });
    await ctx.answerCbQuery();
    await ctx.reply('Proyectos detectados:', {
      reply_markup: {
        inline_keyboard: buildMenuProjectButtons(token, projects),
      },
    });
  });

  bot.action(/^menu_project:([a-z0-9]+):([0-9]+)$/, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupMenuCaches();
    const token = String(ctx.match?.[1] || '');
    const index = Number(ctx.match?.[2]);
    const chatId = Number(ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id);
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!token || !Number.isFinite(chatId)) {
      await ctx.answerCbQuery('Selección inválida.', { show_alert: true });
      return;
    }

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Usa /agent codex primero.', { show_alert: true });
      return;
    }

    const cacheKey = `${chatId}:${token}`;
    const cached = menuProjectCache.get(cacheKey);
    const selected = Array.isArray(cached?.projects) ? cached.projects[index] : undefined;
    if (!selected) {
      await ctx.answerCbQuery('Selección caducada. Usa /menu.', { show_alert: true });
      return;
    }

    const sessions = await listLocalCodexSessions({
      limit: 200,
      cwd: selected.cwd,
    });
    const shortSessions = sessions.slice(0, MENU_SESSION_LIST_LIMIT);
    const sessionToken = createPickerToken();
    menuSessionCache.set(`${chatId}:${sessionToken}`, {
      createdAt: Date.now(),
      cwd: selected.cwd,
      sessions: shortSessions,
    });

    const lines = [
      `Proyecto: ${projectNameFromCwd(selected.cwd)}`,
      shortSessions.length
        ? 'Selecciona una sesión o crea una nueva:'
        : 'No hay sesiones previas. Puedes crear una nueva:',
    ];
    const buttons = [
      ...buildMenuSessionButtons(sessionToken, shortSessions, false),
      [{ text: 'Nueva sesión', callback_data: `menu_session_new:${sessionToken}` }],
      [{ text: 'Volver', callback_data: 'menu_projects' }],
    ];

    await ctx.answerCbQuery();
    await ctx.reply(lines.join('\n'), {
      reply_markup: {
        inline_keyboard: buttons,
      },
    });
  });

  bot.action('menu_sessions', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupMenuCaches();
    const chatId = ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id;
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!chatId) {
      await ctx.answerCbQuery('No pude resolver el chat.', { show_alert: true });
      return;
    }

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Usa /agent codex primero.', { show_alert: true });
      return;
    }

    const sessions = await listLocalCodexSessions({
      limit: MENU_SESSION_LIST_LIMIT,
      cwd: getGlobalAgentCwd(),
    });
    if (!sessions.length) {
      await ctx.answerCbQuery();
      await ctx.reply('No encontré sesiones recientes para el proyecto actual.');
      return;
    }

    const token = createPickerToken();
    menuSessionCache.set(`${chatId}:${token}`, {
      createdAt: Date.now(),
      cwd: getGlobalAgentCwd(),
      sessions,
    });
    await ctx.answerCbQuery();
    await ctx.reply('Sesiones recientes:', {
      reply_markup: {
        inline_keyboard: buildMenuSessionButtons(token, sessions, true),
      },
    });
  });

  bot.action(/^menu_session_new:([a-z0-9]+)$/, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupMenuCaches();
    const token = String(ctx.match?.[1] || '');
    const chatId = Number(ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id);
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!token || !Number.isFinite(chatId)) {
      await ctx.answerCbQuery('Selección inválida.', { show_alert: true });
      return;
    }

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Usa /agent codex primero.', { show_alert: true });
      return;
    }

    const cached = menuSessionCache.get(`${chatId}:${token}`);
    const cwd = String(cached?.cwd || '').trim();
    if (!cwd) {
      await ctx.answerCbQuery('La selección expiró. Usa /menu.', { show_alert: true });
      return;
    }

    setGlobalAgentCwd(cwd);
    clearThreadForAgent(chatId, topicId, effectiveAgentId);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after new session selection:', err)
    );

    try {
      await updateConfig({ agentCwd: cwd });
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery('No pude guardar el proyecto.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery('Nueva sesión lista.');
    await ctx.reply(
      `Proyecto activo: ${projectNameFromCwd(
        cwd
      )}\nSe creó una sesión nueva para este tópico.`,
      {
        reply_markup: {
          remove_keyboard: true,
        },
      }
    );
  });

  bot.action(/^menu_session_attach:([a-z0-9]+):([0-9]+)$/, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupMenuCaches();
    const token = String(ctx.match?.[1] || '');
    const index = Number(ctx.match?.[2]);
    const chatId = Number(ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id);
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!token || !Number.isFinite(chatId)) {
      await ctx.answerCbQuery('Selección inválida.', { show_alert: true });
      return;
    }

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Usa /agent codex primero.', { show_alert: true });
      return;
    }

    const cached = menuSessionCache.get(`${chatId}:${token}`);
    const selected = Array.isArray(cached?.sessions) ? cached.sessions[index] : undefined;
    if (!selected || !isValidSessionId(selected.id)) {
      await ctx.answerCbQuery('Selección caducada. Usa /menu.', { show_alert: true });
      return;
    }

    const cwd = String(selected.cwd || cached?.cwd || '').trim();
    if (cwd) {
      setGlobalAgentCwd(cwd);
      try {
        await updateConfig({ agentCwd: cwd });
      } catch (err) {
        console.error(err);
        await ctx.answerCbQuery('No pude guardar el proyecto.', { show_alert: true });
        return;
      }
    }

    setThreadForAgent(chatId, topicId, effectiveAgentId, selected.id);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after session attach from menu:', err)
    );

    let preview = '';
    try {
      preview = await getLocalCodexSessionLastMessage(selected.id, {
        filePath: selected.filePath,
      });
    } catch (err) {
      console.warn('Failed to get session preview:', err);
    }

    await ctx.answerCbQuery('Sesión conectada.');
    const lines = [`Sesión conectada: ${selected.id}`];
    if (cwd) lines.push(`Proyecto activo: ${projectNameFromCwd(cwd)}`);
    if (preview) lines.push(`Último mensaje: ${preview.slice(0, 240)}`);
    await ctx.reply(lines.join('\n'), {
      reply_markup: {
        remove_keyboard: true,
      },
    });
  });

  bot.command('session', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    const value = extractCommandValue(ctx.message.text);
    if (!value) {
      await ctx.reply('Usage: /session <session_id>');
      return;
    }

    const sessionId = String(value).trim();
    if (!(typeof isValidSessionId === 'function' && isValidSessionId(sessionId))) {
      await ctx.reply('Invalid session id format.');
      return;
    }

    const topicId = getTopicId(ctx);
    const effectiveAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('`/session` is only available when using codex. Use /agent codex.');
      return;
    }

    setThreadForAgent(ctx.chat.id, topicId, effectiveAgentId, sessionId);
    threadTurns.delete(`${buildTopicKey(ctx.chat.id, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after session attach:', err)
    );
    await ctx.reply(`Attached session ${sessionId} to this topic.`);
  });

  bot.action(/^session_attach:(.+)$/, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    const rawSessionId = ctx.match?.[1];
    const sessionId = String(rawSessionId || '').trim();
    if (!(typeof isValidSessionId === 'function' && isValidSessionId(sessionId))) {
      await ctx.answerCbQuery('Invalid session id.', { show_alert: true });
      return;
    }

    const chatId = ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id;
    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    if (!chatId) {
      await ctx.answerCbQuery('Unable to resolve chat context.', { show_alert: true });
      return;
    }

    const effectiveAgentId = getAgentOverride(chatId, topicId) || getGlobalAgent();
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Use /agent codex first.', { show_alert: true });
      return;
    }

    setThreadForAgent(chatId, topicId, effectiveAgentId, sessionId);
    threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
    persistThreads().catch((err) =>
      console.warn('Failed to persist threads after session attach:', err)
    );

    await ctx.answerCbQuery('Session attached.');
    await ctx.reply(`Attached session ${sessionId} to this topic.`);
  });

  bot.action(/^project_open:([a-z0-9]+):([0-9]+)$/, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    cleanupProjectPickerCache();
    const token = String(ctx.match?.[1] || '');
    const index = Number(ctx.match?.[2]);
    const chatId = Number(ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id);
    if (!token || !Number.isFinite(chatId)) {
      await ctx.answerCbQuery('Invalid project selection.', { show_alert: true });
      return;
    }
    const cacheKey = `${chatId}:${token}`;
    const cached = projectPickerCache.get(cacheKey);
    const selected = Array.isArray(cached?.projects) ? cached.projects[index] : undefined;
    if (!selected) {
      await ctx.answerCbQuery('Selection expired. Run /projects again.', {
        show_alert: true,
      });
      return;
    }

    const topicId = ctx?.callbackQuery?.message?.message_thread_id;
    const effectiveAgentId = getAgentOverride(chatId, topicId) || getGlobalAgent();
    if (effectiveAgentId !== 'codex') {
      await ctx.answerCbQuery('Use /agent codex first.', { show_alert: true });
      return;
    }

    setGlobalAgentCwd(selected.cwd);
    try {
      await updateConfig({ agentCwd: selected.cwd });
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery('Failed to persist project.', { show_alert: true });
      return;
    }

    const sessionId = selected.latestSessionId;
    if (sessionId && isValidSessionId(sessionId)) {
      setThreadForAgent(chatId, topicId, effectiveAgentId, sessionId);
      threadTurns.delete(`${buildTopicKey(chatId, topicId)}:${effectiveAgentId}`);
      persistThreads().catch((err) =>
        console.warn('Failed to persist threads after project attach:', err)
      );
      await ctx.answerCbQuery('Project and session attached.');
      await ctx.reply(
        `Project set to ${projectNameFromCwd(
          selected.cwd
        )}\nAttached latest session ${sessionId} to this topic.`
      );
      return;
    }

    await ctx.answerCbQuery('Project selected.');
    await ctx.reply(
      `Project set to ${projectNameFromCwd(
        selected.cwd
      )}\nNo valid recent session id found; next message will start a new one.`
    );
  });
}

module.exports = {
  registerSettingsCommands,
};

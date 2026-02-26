const fs = require('fs/promises');
const path = require('path');
const { buildMainMenuKeyboard } = require('./menu-keyboard');

const SESSION_LIMIT_DEFAULT = 10;
const SESSION_LIMIT_MAX = 30;
const PROJECT_LIMIT_DEFAULT = 12;
const PROJECT_LIMIT_MAX = 20;
const MENU_NAV_TTL_MS = 30 * 60 * 1000;
const MENU_PROJECT_PAGE_SIZE = 8;
const MENU_SESSION_PAGE_SIZE = 6;
const MENU_SEARCH_MAX_RESULTS = 200;

const MENU_BTN_SEARCH = 'Buscar';
const MENU_BTN_PREV = 'Anterior';
const MENU_BTN_NEXT = 'Siguiente';
const MENU_BTN_BACK = 'Volver';
const MENU_BTN_NEW_SESSION = 'Nueva sesión';
const MENU_BTN_CREATE_PROJECT_SESSION = 'Crear una nueva sesión';
const MENU_BTN_LAST_PROJECT_SESSION = 'Última sesión usada';
const MENU_EXPIRED_MESSAGE = 'Este menú expiró o fue reemplazado. Usa /menu.';
const menuNavCache = new Map();
const RESERVED_MENU_LABELS = new Set([
  'projects',
  'project',
  'sesiones',
  'reanudar última',
  'ocultar teclado',
  'buscar',
  'anterior',
  'siguiente',
  'volver',
  'nueva sesión',
]);

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

function sanitizeButtonText(value, max = 60) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function normalizeMenuText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function createMenuInstanceId() {
  const nowPart = Date.now().toString(36).slice(-4);
  const randPart = Math.random().toString(36).slice(2, 6);
  return `${nowPart}${randPart}`.toUpperCase();
}

function sessionDisplayLabel(session) {
  const cwd = String(session?.cwd || '').trim();
  if (!cwd) return shortSessionId(session?.id);
  const project = path.basename(cwd) || cwd;
  return `${project} (${shortSessionId(session?.id)})`;
}

function projectNameFromCwd(cwd) {
  const normalized = String(cwd || '').trim();
  if (!normalized) return '(proyecto desconocido)';
  return path.basename(normalized) || normalized;
}

function normalizeCwdForMatch(cwd) {
  try {
    return path.resolve(String(cwd || '').trim());
  } catch {
    return '';
  }
}

function sessionBelongsToProject(session, projectCwd) {
  const target = normalizeCwdForMatch(projectCwd);
  const candidate = normalizeCwdForMatch(session?.cwd);
  if (!target || !candidate) return false;
  return candidate === target || candidate.startsWith(`${target}${path.sep}`);
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

function resolveMenuStateForChatTopic(chatId, topicId) {
  const exactKey = menuNavKeyFromIds(chatId, topicId);
  const exact = menuNavCache.get(exactKey);
  if (exact) return { key: exactKey, state: exact };

  const rootKey = menuNavKeyFromIds(chatId, undefined);
  if (rootKey !== exactKey) {
    const root = menuNavCache.get(rootKey);
    if (root) return { key: rootKey, state: root };
  }

  let fallbackKey = '';
  let fallbackState = null;
  for (const [key, value] of menuNavCache.entries()) {
    if (!key.startsWith(`${chatId}:`)) continue;
    if (!fallbackState || Number(value?.createdAt || 0) > Number(fallbackState?.createdAt || 0)) {
      fallbackKey = key;
      fallbackState = value;
    }
  }
  if (fallbackState) return { key: fallbackKey, state: fallbackState };
  return { key: exactKey, state: null };
}

function uniqueMenuLabel(base, usedLabels) {
  const trimmed = sanitizeButtonText(base, 44);
  const normalized = normalizeMenuText(trimmed);
  if (!usedLabels.has(normalized) && !RESERVED_MENU_LABELS.has(normalized)) {
    usedLabels.add(normalized);
    return trimmed;
  }
  let i = 2;
  while (true) {
    const candidate = sanitizeButtonText(`${trimmed} (${i})`, 44);
    const normalizedCandidate = normalizeMenuText(candidate);
    if (
      !usedLabels.has(normalizedCandidate) &&
      !RESERVED_MENU_LABELS.has(normalizedCandidate)
    ) {
      usedLabels.add(normalizedCandidate);
      return candidate;
    }
    i += 1;
  }
}

function buildSelectableButtonLabel(selectKey, displayLabel, menuInstanceId = '') {
  const key = String(selectKey || '').trim().toUpperCase();
  const instance = String(menuInstanceId || '').trim().toUpperCase();
  const text = String(displayLabel || '').trim();
  if (instance) {
    return sanitizeButtonText(`${instance} ${key} · ${text}`, 44);
  }
  return sanitizeButtonText(`${key} · ${text}`, 44);
}

function extractSelectPayload(value) {
  const normalized = normalizeMenuText(value);
  const tokenMatch = normalized.match(/^([a-z0-9]{4,8})\s+([ps]\d+)\b/);
  if (tokenMatch) {
    return {
      menuInstanceId: tokenMatch[1].toUpperCase(),
      selectKey: tokenMatch[2].toUpperCase(),
    };
  }
  const keyMatch = normalized.match(/^([ps]\d+)\b/);
  if (keyMatch) {
    return {
      menuInstanceId: '',
      selectKey: keyMatch[1].toUpperCase(),
    };
  }
  return {
    menuInstanceId: '',
    selectKey: '',
  };
}

function buildProjectMenuEntries(projects, menuInstanceId = '') {
  const used = new Set();
  return projects.map((project, index) => {
    const name = projectNameFromCwd(project.cwd);
    const label = uniqueMenuLabel(name, used);
    const selectKey = `P${index + 1}`;
    return {
      label,
      normalizedLabel: normalizeMenuText(label),
      selectKey,
      buttonLabel: buildSelectableButtonLabel(selectKey, label, menuInstanceId),
      project,
    };
  });
}

function buildSessionMenuEntries(sessions, menuInstanceId = '') {
  const used = new Set();
  return sessions.map((session, index) => {
    const when = formatShortWhen(session.timestamp);
    const rawName = String(session?.displayName || '').trim();
    const baseName = rawName || `Sesión ${index + 1}`;
    const base = when ? `${baseName} · ${when}` : baseName;
    const label = uniqueMenuLabel(base, used);
    const selectKey = `S${index + 1}`;
    return {
      label,
      normalizedLabel: normalizeMenuText(label),
      selectKey,
      buttonLabel: buildSelectableButtonLabel(selectKey, label, menuInstanceId),
      session,
    };
  });
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
      ...paged.pageEntries.map((entry) => [{ text: entry.buttonLabel || entry.label }]),
      [{ text: MENU_BTN_SEARCH }],
      ...(navRow.length ? [navRow] : []),
      [{ text: MENU_BTN_BACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildSessionsMenuKeyboard(sessionEntries, page = 0, canCreateNew = true) {
  const paged = getPagedEntries(sessionEntries, page, MENU_SESSION_PAGE_SIZE);
  const navRow = [];
  if (paged.page > 0) navRow.push({ text: MENU_BTN_PREV });
  if (paged.page < paged.totalPages - 1) navRow.push({ text: MENU_BTN_NEXT });
  const actionsRows = canCreateNew ? [[{ text: MENU_BTN_NEW_SESSION }]] : [];

  return {
    keyboard: [
      ...paged.pageEntries.map((entry) => [{ text: entry.buttonLabel || entry.label }]),
      [{ text: MENU_BTN_SEARCH }],
      ...(navRow.length ? [navRow] : []),
      ...actionsRows,
      [{ text: MENU_BTN_BACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildProjectActionsKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BTN_CREATE_PROJECT_SESSION }],
      [{ text: MENU_BTN_LAST_PROJECT_SESSION }],
      [{ text: MENU_BTN_BACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
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

  function setMainMenuState(chatId, topicId) {
    const key = menuNavKeyFromIds(chatId, topicId);
    menuNavCache.set(key, {
      createdAt: Date.now(),
      menuInstanceId: createMenuInstanceId(),
      level: 'main',
      page: 0,
      query: '',
      awaitingSearch: false,
    });
  }

  async function openMainMenu(ctx) {
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (chatId) {
      setMainMenuState(chatId, topicId);
    }
    await ctx.reply('Menú principal:', {
      reply_markup: buildMainMenuKeyboard(),
    });
  }

  async function openProjectsMenu(ctx, options = {}) {
    cleanupMenuNavCache();
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const limit =
      Number.isFinite(options.limitOverride) && options.limitOverride > 0
        ? Math.min(options.limitOverride, PROJECT_LIMIT_MAX)
        : PROJECT_LIMIT_MAX;
    const sessions = await listLocalCodexSessions({ limit: 300 });
    const projects = buildProjectListFromSessions(sessions).slice(0, limit);
    if (!projects.length) {
      await ctx.reply('No encontré proyectos locales en sesiones de Codex.');
      return;
    }

    const menuInstanceId = createMenuInstanceId();
    const projectEntries = buildProjectMenuEntries(projects, menuInstanceId);
    const key = menuNavKeyFromIds(chatId, topicId);
    menuNavCache.set(key, {
      createdAt: Date.now(),
      menuInstanceId,
      level: 'projects',
      projectEntries,
      filteredProjectEntries: projectEntries,
      sessionsSnapshot: sessions,
      page: 0,
      query: '',
      awaitingSearch: false,
    });

    const paged = getPagedEntries(projectEntries, 0, MENU_PROJECT_PAGE_SIZE);
    await ctx.reply(
      `Selecciona un proyecto (${paged.totalItems}) · página ${paged.page + 1}/${paged.totalPages}.`,
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
      `Selecciona un proyecto (${paged.totalItems})${queryPart} · página ${paged.page + 1}/${paged.totalPages}.`,
      {
        reply_markup: buildProjectsMenuKeyboard(filtered, paged.page),
      }
    );
  }

  async function openProjectActionsMenu(ctx, state, selectedEntry) {
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId || !selectedEntry?.project) return;

    const key = menuNavKeyFromIds(chatId, topicId);
    const selectedProject = selectedEntry.project;
    menuNavCache.set(key, {
      createdAt: Date.now(),
      menuInstanceId: createMenuInstanceId(),
      level: 'project_actions',
      selectedProject,
      projectEntries: Array.isArray(state?.projectEntries) ? state.projectEntries : [],
      filteredProjectEntries: Array.isArray(state?.filteredProjectEntries)
        ? state.filteredProjectEntries
        : Array.isArray(state?.projectEntries)
          ? state.projectEntries
          : [],
      returnProjectsPage: Number(state?.page) || 0,
      returnProjectsQuery: String(state?.query || ''),
      returnProjectsMenuInstanceId: String(state?.menuInstanceId || ''),
      sessionsSnapshot: Array.isArray(state?.sessionsSnapshot) ? state.sessionsSnapshot : [],
      awaitingSearch: false,
    });

    await ctx.reply(`Proyecto: ${projectNameFromCwd(selectedProject.cwd)}\n¿Qué quieres hacer?`, {
      reply_markup: buildProjectActionsKeyboard(),
    });
  }

  function resolveStateCwd(state) {
    const selectedProjectCwd = String(state?.selectedProject?.cwd || '').trim();
    if (selectedProjectCwd) return selectedProjectCwd;
    return String(state?.cwd || '').trim();
  }

  async function renderSessionsPage(ctx, state) {
    const entries = Array.isArray(state?.filteredSessionEntries)
      ? state.filteredSessionEntries
      : [];
    const page = Number(state?.page) || 0;
    const paged = getPagedEntries(entries, page, MENU_SESSION_PAGE_SIZE);
    const queryPart = state?.query ? ` · filtro: "${state.query}"` : '';
    const header = state?.selectedProject?.cwd
      ? `Proyecto: ${projectNameFromCwd(state.selectedProject.cwd)}`
      : 'Sesiones recientes del proyecto activo';
    const canCreateNew = Boolean(resolveStateCwd(state));
    const subtitle = paged.totalItems
      ? `Selecciona sesión${canCreateNew ? ' o crea una nueva' : ''} (${paged.totalItems})${queryPart} · página ${paged.page + 1}/${paged.totalPages}.`
      : canCreateNew
        ? `No hay sesiones en esta vista${queryPart}. Puedes crear una nueva o volver.`
        : `No hay sesiones en esta vista${queryPart}. Usa Projects para elegir un proyecto.`;
    await ctx.reply([header, subtitle].join('\n'), {
      reply_markup: buildSessionsMenuKeyboard(entries, paged.page, canCreateNew),
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
    setMainMenuState(chatId, topicId);
    await ctx.reply(`Sesión reanudada: ${sessionId}`, {
      reply_markup: buildMainMenuKeyboard(),
    });
  }

  async function openSessionsMenu(ctx, options = {}) {
    cleanupMenuNavCache();
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const { state: previousState } = resolveMenuStateForChatTopic(chatId, topicId);
    const selectedProject = options.projectContext || null;
    const cwd = String(
      options.cwdOverride || selectedProject?.cwd || getGlobalAgentCwd()
    ).trim();
    const limit =
      Number.isFinite(options.limitOverride) && options.limitOverride > 0
        ? Math.min(options.limitOverride, MENU_SEARCH_MAX_RESULTS)
        : MENU_SEARCH_MAX_RESULTS;

    const candidateSessions = Array.isArray(options.sessionCandidates)
      ? options.sessionCandidates
      : null;
    const sessions = candidateSessions
      ? candidateSessions.slice(0, limit)
      : await listLocalCodexSessions({
          limit,
          cwd,
        });
    const menuInstanceId = createMenuInstanceId();
    const sessionEntries = buildSessionMenuEntries(sessions, menuInstanceId);
    const key = menuNavKeyFromIds(chatId, topicId);
    const level = selectedProject ? 'project_sessions' : 'sessions';
    menuNavCache.set(key, {
      createdAt: Date.now(),
      menuInstanceId,
      level,
      selectedProject,
      projectEntries: Array.isArray(previousState?.projectEntries)
        ? previousState.projectEntries
        : [],
      filteredProjectEntries: Array.isArray(previousState?.filteredProjectEntries)
        ? previousState.filteredProjectEntries
        : Array.isArray(previousState?.projectEntries)
          ? previousState.projectEntries
          : [],
      returnProjectsPage: Number(previousState?.page) || 0,
      returnProjectsQuery: String(previousState?.query || ''),
      sessionsSnapshot: Array.isArray(previousState?.sessionsSnapshot)
        ? previousState.sessionsSnapshot
        : [],
      sessionEntries,
      filteredSessionEntries: sessionEntries,
      cwd,
      page: 0,
      query: '',
      awaitingSearch: false,
    });
    await renderSessionsPage(ctx, menuNavCache.get(key));
  }

  async function attachSessionFromEntry(ctx, state, sessionEntry) {
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId || !sessionEntry?.session) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const selected = sessionEntry.session;
    const cwd = String(
      selected.cwd || state?.selectedProject?.cwd || state?.cwd || ''
    ).trim();
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

    setMainMenuState(chatId, topicId);
    const lines = [`Sesión conectada: ${selected.id}`];
    if (cwd) lines.push(`Proyecto activo: ${projectNameFromCwd(cwd)}`);
    if (preview) lines.push(`Último mensaje: ${preview.slice(0, 240)}`);
    await ctx.reply(lines.join('\n'), {
      reply_markup: buildMainMenuKeyboard(),
    });
  }

  async function createNewSessionFromState(ctx, state) {
    const chatId = ctx?.chat?.id || ctx?.message?.chat?.id;
    const topicId = getTopicId(ctx);
    if (!chatId) return;

    const effectiveAgentId = effectiveAgentFor(chatId, topicId);
    if (effectiveAgentId !== 'codex') {
      await ctx.reply('Usa /agent codex primero.');
      return;
    }

    const cwd = resolveStateCwd(state);
    if (!cwd) {
      await ctx.reply('No pude resolver el proyecto. Abre Projects desde /menu.');
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
      await replyWithError(ctx, 'No pude guardar el proyecto.', err);
      return;
    }

    setMainMenuState(chatId, topicId);
    await ctx.reply(
      `Proyecto activo: ${projectNameFromCwd(
        cwd
      )}\nSe creó una sesión nueva para este tópico.`,
      {
        reply_markup: buildMainMenuKeyboard(),
      }
    );
  }

  async function attachLastSessionForProject(ctx, state) {
    const selectedProject = state?.selectedProject;
    const projectCwd = String(selectedProject?.cwd || '').trim();
    if (!projectCwd) {
      await ctx.reply('No pude resolver el proyecto. Abre Projects desde /menu.');
      return;
    }

    const snapshotCandidates = Array.isArray(state?.sessionsSnapshot)
      ? state.sessionsSnapshot.filter((session) =>
          sessionBelongsToProject(session, projectCwd)
        )
      : [];
    const sortedSnapshot = snapshotCandidates.sort((a, b) =>
      String(b?.timestamp || '').localeCompare(String(a?.timestamp || ''))
    );
    let latestSession = sortedSnapshot.find((session) =>
      isValidSessionId(String(session?.id || '').trim())
    );

    if (!latestSession) {
      const freshSessions = await listLocalCodexSessions({
        limit: MENU_SEARCH_MAX_RESULTS,
        cwd: projectCwd,
      });
      latestSession = freshSessions.find((session) =>
        isValidSessionId(String(session?.id || '').trim())
      );
    }

    if (!latestSession) {
      await ctx.reply('No hay sesiones previas en este proyecto. Creo una nueva.');
      await createNewSessionFromState(ctx, {
        ...state,
        cwd: projectCwd,
      });
      return;
    }

    await attachSessionFromEntry(ctx, state, {
      label: '',
      normalizedLabel: '',
      selectKey: '',
      buttonLabel: '',
      session: latestSession,
    });
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
    const rawValue = extractCommandValue(ctx.message.text);
    const limit = parseSessionLimit(rawValue);
    try {
      await openSessionsMenu(ctx, {
        limitOverride: limit,
        cwdOverride: getGlobalAgentCwd(),
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude abrir sesiones del menú.', err);
    }
  });

  bot.command('projects', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    const rawValue = extractCommandValue(ctx.message.text);
    const limit = parseProjectLimit(rawValue);
    try {
      await openProjectsMenu(ctx, {
        limitOverride: limit,
      });
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'No pude abrir proyectos del menú.', err);
    }
  });

  bot.command('menu', async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    await openMainMenu(ctx);
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

  bot.hears(/^projects?$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    try {
      await openProjectsMenu(ctx);
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
      await openSessionsMenu(ctx, {
        cwdOverride: getGlobalAgentCwd(),
      });
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
    const { key, state } = resolveMenuStateForChatTopic(ctx.chat.id, getTopicId(ctx));
    if (!state || state.level === 'main') {
      await openMainMenu(ctx);
      return;
    }
    if (state.level === 'project_actions') {
      const previous = {
        createdAt: Date.now(),
        menuInstanceId: state.returnProjectsMenuInstanceId || createMenuInstanceId(),
        level: 'projects',
        projectEntries: Array.isArray(state.projectEntries) ? state.projectEntries : [],
        filteredProjectEntries: Array.isArray(state.filteredProjectEntries)
          ? state.filteredProjectEntries
          : Array.isArray(state.projectEntries)
            ? state.projectEntries
            : [],
        page: Number(state.returnProjectsPage) || 0,
        query: String(state.returnProjectsQuery || ''),
        sessionsSnapshot: Array.isArray(state.sessionsSnapshot) ? state.sessionsSnapshot : [],
        awaitingSearch: false,
      };
      if (!Array.isArray(previous.projectEntries) || !previous.projectEntries.length) {
        try {
          await openProjectsMenu(ctx);
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
    if (state.level === 'project_sessions') {
      const previous = {
        createdAt: Date.now(),
        menuInstanceId: state.menuInstanceId || createMenuInstanceId(),
        level: 'projects',
        projectEntries: Array.isArray(state.projectEntries)
          ? state.projectEntries
          : [],
        filteredProjectEntries: Array.isArray(state.filteredProjectEntries)
          ? state.filteredProjectEntries
          : Array.isArray(state.projectEntries)
            ? state.projectEntries
          : [],
        page: Number(state.returnProjectsPage) || 0,
        query: String(state.returnProjectsQuery || ''),
        sessionsSnapshot: Array.isArray(state.sessionsSnapshot) ? state.sessionsSnapshot : [],
        awaitingSearch: false,
      };
      if (!Array.isArray(previous.projectEntries) || !previous.projectEntries.length) {
        try {
          await openProjectsMenu(ctx);
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
    await openMainMenu(ctx);
  });

  bot.hears(/^buscar$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const { key, state } = resolveMenuStateForChatTopic(ctx.chat.id, getTopicId(ctx));
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
    const { key, state } = resolveMenuStateForChatTopic(ctx.chat.id, getTopicId(ctx));
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
    const { key, state } = resolveMenuStateForChatTopic(ctx.chat.id, getTopicId(ctx));
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
    const { state } = resolveMenuStateForChatTopic(chatId, topicId);
    if (!state || (state.level !== 'project_sessions' && state.level !== 'sessions')) return;

    await createNewSessionFromState(ctx, state);
  });

  bot.hears(/^crear una nueva sesión$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const { state } = resolveMenuStateForChatTopic(chatId, topicId);
    if (!state || state.level !== 'project_actions') return;
    await createNewSessionFromState(ctx, state);
  });

  bot.hears(/^(última|ultima) sesión usada$/i, async (ctx) => {
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    cleanupMenuNavCache();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const { state } = resolveMenuStateForChatTopic(chatId, topicId);
    if (!state || state.level !== 'project_actions') return;
    await attachLastSessionForProject(ctx, state);
  });

  bot.hears(/^.+$/, async (ctx, next) => {
    cleanupMenuNavCache();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const selectedLabel = String(ctx.message?.text || '').trim();
    const {
      menuInstanceId: selectedMenuInstanceId,
      selectKey: selectedKey,
    } = extractSelectPayload(selectedLabel);
    const { state } = resolveMenuStateForChatTopic(chatId, topicId);
    if (!state) {
      if (selectedKey) {
        if (!canUseSensitiveCommands()) {
          await denySensitiveCommand(ctx);
          return;
        }
        await ctx.reply(MENU_EXPIRED_MESSAGE);
        return;
      }
      return next();
    }
    if (!canUseSensitiveCommands()) {
      await denySensitiveCommand(ctx);
      return;
    }
    if (
      selectedKey &&
      state.level !== 'projects' &&
      state.level !== 'project_sessions' &&
      state.level !== 'sessions'
    ) {
      await ctx.reply(MENU_EXPIRED_MESSAGE);
      return;
    }
    if (
      selectedKey &&
      selectedMenuInstanceId &&
      state.menuInstanceId &&
      selectedMenuInstanceId !== state.menuInstanceId
    ) {
      await ctx.reply(MENU_EXPIRED_MESSAGE);
      return;
    }

    if (state.level === 'projects') {
      const selectedEntry = selectedKey
        ? (state.filteredProjectEntries || []).find(
            (entry) => entry.selectKey === selectedKey
          )
        : null;
      if (!selectedEntry) {
        await ctx.reply('No reconocí ese proyecto. Usa los botones del teclado o /menu.');
        return;
      }
      try {
        await openProjectActionsMenu(ctx, state, selectedEntry);
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'No pude abrir las acciones del proyecto.', err);
      }
      return;
    }

    if (state.level === 'project_actions') {
      await ctx.reply('Elige una opción del proyecto o pulsa Volver.');
      return;
    }

    if (state.level !== 'project_sessions' && state.level !== 'sessions') return next();

    const selectedEntry = selectedKey
      ? (state.filteredSessionEntries || []).find(
          (entry) => entry.selectKey === selectedKey
        )
      : null;
    const selectedSessionId = String(selectedEntry?.session?.id || '').trim();
    if (!selectedEntry || !selectedSessionId || !isValidSessionId(selectedSessionId)) {
      await ctx.reply('No reconocí esa sesión. Usa los botones del teclado o /menu.');
      return;
    }
    await attachSessionFromEntry(ctx, state, selectedEntry);
    return;
  });

  bot.on('text', async (ctx, next) => {
    cleanupMenuNavCache();
    const { key, state } = resolveMenuStateForChatTopic(ctx.chat.id, getTopicId(ctx));
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

  async function replyLegacyMenuAction(ctx) {
    if (!canUseSensitiveCommands()) {
      await denySensitiveAction(ctx);
      return;
    }
    await ctx.answerCbQuery(MENU_EXPIRED_MESSAGE, { show_alert: true });
    await ctx.reply(MENU_EXPIRED_MESSAGE);
  }

  bot.action('menu_main', replyLegacyMenuAction);
  bot.action('menu_projects', replyLegacyMenuAction);
  bot.action('menu_sessions', replyLegacyMenuAction);
  bot.action(/^menu_project:([a-z0-9]+):([0-9]+)$/, replyLegacyMenuAction);
  bot.action(/^menu_session_new:([a-z0-9]+)$/, replyLegacyMenuAction);
  bot.action(/^menu_session_attach:([a-z0-9]+):([0-9]+)$/, replyLegacyMenuAction);

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

  bot.action(/^session_attach:(.+)$/, replyLegacyMenuAction);
  bot.action(/^project_open:([a-z0-9]+):([0-9]+)$/, replyLegacyMenuAction);
}

module.exports = {
  registerSettingsCommands,
};

const cp = require('child_process');
const readline = require('node:readline');

const SERVER_COMMAND = 'codex';
const SERVER_ARGS = ['app-server', '--session-source', 'aipal'];
const CLIENT_INFO = {
  name: 'aipal',
  title: 'Aipal',
  version: '0.2.0',
};

function createCodexAppServerClient(options = {}) {
  const {
    clientInfo = CLIENT_INFO,
    cwd = process.cwd(),
    logger = console,
    serverArgs = SERVER_ARGS,
    serverCommand = SERVER_COMMAND,
    spawnProcess = cp.spawn,
  } = options;

  let proc = null;
  let lineReader = null;
  let nextRequestId = 1;
  let startPromise = null;
  let initialized = false;
  const pendingResponses = new Map();
  const activeTurns = new Map();
  const pendingServerRequests = new Map();

  function createError(message, details = {}) {
    const err = new Error(message);
    Object.assign(err, details);
    return err;
  }

  function buildResponseError(error) {
    if (!error || typeof error !== 'object') {
      return createError('Codex app-server request failed');
    }
    const message = error.message || 'Codex app-server request failed';
    return createError(message, {
      code: error.code,
      data: error.data,
    });
  }

  function buildLineParseError(line, err) {
    return createError('Failed to parse app-server message', {
      cause: err,
      line,
    });
  }

  function buildProcessExitError(reason) {
    return createError(`Codex app-server exited${reason ? `: ${reason}` : ''}`);
  }

  function omitUndefined(obj) {
    return Object.fromEntries(
      Object.entries(obj).filter(([, value]) => value !== undefined)
    );
  }

  function normalizeResponse(result) {
    return result === undefined ? {} : result;
  }

  function sendRaw(message) {
    if (!proc || proc.killed || !proc.stdin || proc.stdin.destroyed) {
      throw createError('Codex app-server is not running');
    }
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function rejectPendingResponses(error) {
    for (const pending of pendingResponses.values()) {
      pending.reject(error);
    }
    pendingResponses.clear();
  }

  function failActiveTurns(error) {
    for (const context of activeTurns.values()) {
      context.fail(error);
    }
    activeTurns.clear();
  }

  function clearProcessState() {
    initialized = false;
    proc = null;
    if (lineReader) {
      lineReader.close();
      lineReader = null;
    }
  }

  function cleanupServerRequestsForThread(threadId) {
    for (const [requestId, pending] of pendingServerRequests.entries()) {
      if (pending.threadId !== threadId) continue;
      pending.resolved = true;
      pendingServerRequests.delete(requestId);
    }
  }

  function createTurnContext({
    includeAgentDeltas = true,
    onApprovalResolved,
    onFinalResponse,
    onTurnStarted,
    onProgressUpdate,
    requestApproval,
    threadId,
  }) {
    const deferred = createDeferred();
    const progressOrder = [];
    const progressTexts = new Map();
    const finalTexts = new Map();
    const itemPhases = new Map();
    const deltaTexts = new Map();
    const itemsById = new Map();

    function summarizeNonMessageItem(item, source) {
      if (!item || typeof item !== 'object') return '';
      const type = String(item.type || '').trim();
      if (!type || type === 'agentMessage') return '';

      if (type === 'reasoning') {
        return '';
      }

      if (type === 'commandExecution') {
        return '';
      }

      if (type === 'fileChange') {
        if (source === 'completed') return '';
        const changeCount = Array.isArray(item.changes) ? item.changes.length : null;
        const suffix = changeCount ? ` (${changeCount})` : '';
        return `Preparando cambios de archivos${suffix}...`;
      }

      const toolName = String(
        item.tool
        || item.name
        || item.serverToolName
        || item.mcpToolName
        || item.callName
        || ''
      ).trim();
      if (type.toLowerCase().includes('tool') || toolName) {
        if (source === 'completed') return '';
        const label = toolName || type;
        return `Usando herramienta: ${label}`;
      }

      return '';
    }

    const context = {
      completed: false,
      completion: deferred.promise,
      finalEmitted: false,
      includeAgentDeltas,
      lastAgentText: '',
      onApprovalResolved,
      onFinalResponse,
      onTurnStarted,
      onProgressUpdate,
      requestApproval,
      threadId,
      turnId: null,
      notifyTurnStarted() {
        if (
          typeof context.onTurnStarted === 'function'
          && context.threadId
          && context.turnId
        ) {
          context.onTurnStarted({
            threadId: context.threadId,
            turnId: context.turnId,
          });
        }
      },
      updateProgress(itemId, text) {
        const normalized = String(text || '').trim();
        if (!progressTexts.has(itemId)) {
          progressOrder.push(itemId);
        }
        progressTexts.set(itemId, normalized);
        if (typeof context.onProgressUpdate !== 'function') return;
        const combined = progressOrder
          .map((id) => progressTexts.get(id))
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        if (!combined) return;
        context.onProgressUpdate({ mode: 'raw', text: combined });
      },
      updateFinal(itemId, text) {
        finalTexts.set(itemId, text);
        context.lastAgentText = text || context.lastAgentText;
      },
      handleAgentMessage(item, source = 'completed') {
        const itemId = String(item?.id || `${source}:unknown`);
        itemsById.set(itemId, item);
        const phase = String(item?.phase || '').toLowerCase();
        if (phase) {
          itemPhases.set(itemId, phase);
        }
        const buffered = deltaTexts.get(itemId) || '';
        const text = typeof item?.text === 'string' && item.text
          ? item.text
          : buffered;
        if (text) {
          context.lastAgentText = text;
        }
        if (phase !== 'final_answer' && text) {
          context.updateProgress(itemId, text);
        }
        if (phase === 'commentary') {
          return;
        }
        if (phase === 'final_answer') {
          context.updateFinal(itemId, text);
          if (source === 'completed') {
            context.emitFinal(text);
          }
          return;
        }
        if (text) {
          context.lastAgentText = text;
        }
      },
      handleItem(item, source) {
        const itemId = item?.id ? String(item.id) : null;
        if (itemId) {
          itemsById.set(itemId, item);
        }
        if (item?.type === 'agentMessage') {
          context.handleAgentMessage(item, source);
          return;
        }
        if (itemId) {
          const summary = summarizeNonMessageItem(item, source);
          if (summary || source === 'completed') {
            context.updateProgress(itemId, summary);
          }
        }
      },
      handleAgentDelta({ delta, itemId }) {
        if (!itemId) return;
        const nextText = `${deltaTexts.get(itemId) || ''}${String(delta || '')}`;
        deltaTexts.set(itemId, nextText);
        context.lastAgentText = nextText || context.lastAgentText;
        if (!context.includeAgentDeltas) {
          return;
        }
        const phase = itemPhases.get(itemId);
        if (phase === 'final_answer') {
          context.updateFinal(itemId, nextText);
        } else {
          context.updateProgress(itemId, nextText);
        }
      },
      emitFinal(text) {
        const normalized = String(text || '').trim();
        if (!normalized || context.finalEmitted) return;
        context.finalEmitted = true;
        if (typeof context.onFinalResponse === 'function') {
          context.onFinalResponse(normalized);
        }
      },
      getItem(itemId) {
        return itemsById.get(itemId) || null;
      },
      getResultText() {
        const explicitFinal = Array.from(finalTexts.values())
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .slice(-1)[0];
        if (explicitFinal) return explicitFinal;
        return String(context.lastAgentText || '').trim();
      },
      resolve(result) {
        if (context.completed) return;
        context.completed = true;
        deferred.resolve(result);
      },
      fail(error) {
        if (context.completed) return;
        context.completed = true;
        deferred.reject(error);
      },
    };

    return context;
  }

  function getActiveContext(threadId, turnId = null) {
    const context = activeTurns.get(threadId);
    if (!context) return null;
    if (turnId && context.turnId && context.turnId !== turnId) return null;
    return context;
  }

  async function handleServerRequest(message) {
    const { id, method, params = {} } = message;
    const requestId = id;
    const threadId = String(params.threadId || '');

    if (
      method !== 'item/commandExecution/requestApproval'
      && method !== 'item/fileChange/requestApproval'
    ) {
      sendRaw({
        id: requestId,
        error: { code: -32601, message: `Unsupported app-server method: ${method}` },
      });
      return;
    }

    const context = getActiveContext(threadId);

    if (!context) {
      try {
        sendRaw({ id: requestId, result: { decision: 'cancel' } });
      } catch (err) {
        logger.warn('Failed to respond to orphaned server request:', err);
      }
      return;
    }

    pendingServerRequests.set(requestId, { resolved: false, threadId });

    const kind =
      method === 'item/fileChange/requestApproval'
        ? 'file_change'
        : 'command_execution';

    let decision = null;
    try {
      const approvalItem = context.getItem(String(params.itemId || ''));
      if (typeof context.requestApproval === 'function') {
        decision = await context.requestApproval({
          ...params,
          kind,
          item: approvalItem,
          requestId,
        });
      }
    } catch (err) {
      logger.warn('Approval callback failed:', err);
    }

    const pending = pendingServerRequests.get(requestId);
    if (!pending || pending.resolved) {
      return;
    }

    const normalizedDecision =
      typeof decision === 'string' && decision.trim() ? decision.trim() : 'cancel';
    sendRaw({ id: requestId, result: { decision: normalizedDecision } });
  }

  function handleNotification(message) {
    const { method, params = {} } = message;

    if (method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      const threadId = String(params.threadId || '');
      const pending = pendingServerRequests.get(requestId);
      if (pending) {
        pending.resolved = true;
        pendingServerRequests.delete(requestId);
      }
      const context = getActiveContext(threadId);
      if (context && typeof context.onApprovalResolved === 'function') {
        context.onApprovalResolved({ requestId, threadId });
      }
      return;
    }

    const threadId = String(params.threadId || '');
    const turnId = params.turnId ? String(params.turnId) : null;
    const context = getActiveContext(threadId, turnId);
    if (!context) {
      return;
    }

    if (method === 'turn/started') {
      const turn = params.turn || {};
      if (turn.id) {
        context.turnId = String(turn.id);
        context.notifyTurnStarted();
      }
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      context.handleItem(item, method === 'item/started' ? 'started' : 'completed');
      return;
    }

    if (method === 'item/agentMessage/delta') {
      context.handleAgentDelta({
        delta: params.delta,
        itemId: String(params.itemId || ''),
      });
      return;
    }

    if (method === 'error') {
      const detail = params.error || {};
      context.fail(
        createError(detail.message || 'Codex app-server turn failed', {
          codexErrorInfo: detail.codexErrorInfo,
        })
      );
      cleanupServerRequestsForThread(threadId);
      activeTurns.delete(threadId);
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn || {};
      const status = String(turn.status || '');
      const resultText = context.getResultText();
      if (resultText) {
        context.emitFinal(resultText);
      }
      cleanupServerRequestsForThread(threadId);
      activeTurns.delete(threadId);
      if (status === 'failed') {
        const error = turn.error || {};
        context.fail(
          createError(error.message || 'Codex app-server turn failed', {
            additionalDetails: error.additionalDetails,
            codexErrorInfo: error.codexErrorInfo,
          })
        );
        return;
      }
      if (status === 'interrupted') {
        context.fail(
          createError('Codex app-server turn interrupted', {
            code: 'ERR_RUN_INTERRUPTED',
          })
        );
        return;
      }
      context.resolve({
        text: resultText,
        threadId,
        turnId: turn.id ? String(turn.id) : context.turnId,
      });
    }
  }

  function handleMessage(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      logger.warn(buildLineParseError(line, err));
      return;
    }

    if (message && Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = pendingResponses.get(message.id);
      if (!pending) return;
      pendingResponses.delete(message.id);
      if (message.error) {
        pending.reject(buildResponseError(message.error));
      } else {
        pending.resolve(normalizeResponse(message.result));
      }
      return;
    }

    if (message && Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method')) {
      void handleServerRequest(message);
      return;
    }

    if (message && Object.hasOwn(message, 'method')) {
      handleNotification(message);
    }
  }

  function handleProcessExit(reason) {
    clearProcessState();
    const error = buildProcessExitError(reason);
    rejectPendingResponses(error);
    failActiveTurns(error);
    for (const pending of pendingServerRequests.values()) {
      pending.resolved = true;
    }
    pendingServerRequests.clear();
    startPromise = null;
  }

  function requestInternal(method, params) {
    const requestId = nextRequestId++;
    const deferred = createDeferred();
    pendingResponses.set(requestId, deferred);
    try {
      sendRaw(omitUndefined({ method, id: requestId, params }));
    } catch (err) {
      pendingResponses.delete(requestId);
      deferred.reject(err);
    }
    return deferred.promise;
  }

  async function start() {
    if (initialized && proc && !proc.killed) {
      return;
    }
    if (startPromise) {
      await startPromise;
      return;
    }

    startPromise = (async () => {
      proc = spawnProcess(serverCommand, serverArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (proc.stdout && typeof proc.stdout.setEncoding === 'function') {
        proc.stdout.setEncoding('utf8');
      }
      if (proc.stderr && typeof proc.stderr.setEncoding === 'function') {
        proc.stderr.setEncoding('utf8');
      }

      lineReader = readline.createInterface({ input: proc.stdout });
      lineReader.on('line', handleMessage);

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          const text = String(chunk || '').trim();
          if (text) {
            logger.warn(`[codex-app-server] ${text}`);
          }
        });
      }

      proc.once('error', (err) => {
        handleProcessExit(err.message || err.code || 'error');
      });
      proc.once('close', (code, signal) => {
        handleProcessExit(signal || `exit code ${code}`);
      });

      await requestInternal('initialize', {
        capabilities: { experimentalApi: true },
        clientInfo,
      });
      sendRaw({ method: 'initialized', params: {} });
      initialized = true;
    })();

    try {
      await startPromise;
    } catch (err) {
      startPromise = null;
      throw err;
    }
  }

  async function request(method, params) {
    await start();
    return requestInternal(method, params);
  }

  async function createThread(threadId, model) {
    if (threadId) {
      await request('thread/resume', { threadId });
      return threadId;
    }
    const result = await request('thread/start', omitUndefined({ model }));
    const createdThreadId =
      result.thread?.id || result.threadId || result.id || null;
    if (!createdThreadId) {
      throw createError('Codex app-server did not return a thread id');
    }
    return String(createdThreadId);
  }

  async function runTurn(options = {}) {
    const {
      approvalPolicy = 'on-request',
      cwd: turnCwd = process.cwd(),
      effort,
      includeAgentDeltas = true,
      input,
      model,
      onApprovalResolved,
      onFinalResponse,
      onTurnStarted,
      onProgressUpdate,
      requestApproval,
      sandboxPolicy = { type: 'dangerFullAccess' },
      threadId,
    } = options;

    const resolvedThreadId = await createThread(threadId, model);
    const context = createTurnContext({
      includeAgentDeltas,
      onApprovalResolved,
      onFinalResponse,
      onTurnStarted,
      onProgressUpdate,
      requestApproval,
      threadId: resolvedThreadId,
    });
    activeTurns.set(resolvedThreadId, context);

    try {
      const result = await request('turn/start', omitUndefined({
        approvalPolicy,
        cwd: turnCwd,
        effort,
        input,
        model,
        sandboxPolicy,
        threadId: resolvedThreadId,
      }));
      if (result.turn?.id) {
        context.turnId = String(result.turn.id);
        context.notifyTurnStarted();
      }
      return await context.completion;
    } catch (err) {
      cleanupServerRequestsForThread(resolvedThreadId);
      activeTurns.delete(resolvedThreadId);
      throw err;
    }
  }

  async function runChatTurn(options = {}) {
    return runTurn(options);
  }

  async function runOneShot(options = {}) {
    let approvalRequested = false;
    const result = await runTurn({
      ...options,
      requestApproval: async () => {
        approvalRequested = true;
        return 'cancel';
      },
    });
    if (approvalRequested) {
      throw createError(
        'codex-app one-shot requested approval; interactive approvals are not supported for one-shot runs.'
      );
    }
    return result;
  }

  async function listModels() {
    const result = await request('model/list', {});
    return Array.isArray(result.data) ? result.data : [];
  }

  async function interruptTurn({ threadId, turnId }) {
    if (!threadId || !turnId) {
      throw createError('threadId and turnId are required to interrupt a turn');
    }
    return request('turn/interrupt', {
      threadId: String(threadId),
      turnId: String(turnId),
    });
  }

  async function steerTurn({ expectedTurnId, input, threadId }) {
    if (!threadId || !expectedTurnId) {
      throw createError(
        'threadId and expectedTurnId are required to steer a turn'
      );
    }
    if (!Array.isArray(input) || input.length === 0) {
      throw createError('input is required to steer a turn');
    }
    return request('turn/steer', {
      expectedTurnId: String(expectedTurnId),
      input,
      threadId: String(threadId),
    });
  }

  async function shutdown() {
    const error = createError('Codex app-server client shut down');
    rejectPendingResponses(error);
    failActiveTurns(error);
    for (const pending of pendingServerRequests.values()) {
      pending.resolved = true;
    }
    pendingServerRequests.clear();
    startPromise = null;
    initialized = false;
    if (!proc) {
      clearProcessState();
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {}
    clearProcessState();
  }

  return {
    interruptTurn,
    listModels,
    runChatTurn,
    runOneShot,
    shutdown,
    steerTurn,
  };
}

module.exports = {
  createCodexAppServerClient,
};

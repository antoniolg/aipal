function createAgentRunner(options) {
  const {
    agentMaxBuffer,
    agentTimeoutMs,
    buildBootstrapContext,
    buildPrompt,
    documentDir,
    execLocal,
    execLocalStreaming,
    fileInstructionsEvery,
    getAgent,
    getAgentLabel,
    getGlobalAgent,
    getGlobalModels,
    getGlobalThinking,
    getThreads,
    imageDir,
    persistThreads,
    postFinalGraceMs = 2500,
    prefixTextWithTimestamp,
    resolveEffectiveAgentId,
    resolveThreadId,
    runSessionBackedChatTurn,
    runSessionBackedOneShot,
    setSessionBackedThreadTitle,
    steerSessionBackedTurn,
    stopSessionBackedTurn,
    shellQuote,
    terminateChildProcess,
    threadTurns,
    wrapCommandWithPty,
    defaultTimeZone,
  } = options;
  const activeRuns = new Set();
  const activeRunsByKey = new Map();

  function buildActiveRunKey(chatId, topicId, agentId, contextKey) {
    return `${chatId}:${contextKey || topicId || 'root'}:${agentId}`;
  }

  function trackActiveRun(run) {
    activeRuns.add(run);
    if (run.activeKey) {
      activeRunsByKey.set(run.activeKey, run);
    }
  }

  function untrackActiveRun(run) {
    activeRuns.delete(run);
    if (run?.activeKey && activeRunsByKey.get(run.activeKey) === run) {
      activeRunsByKey.delete(run.activeKey);
    }
  }

  function scheduleRunTermination(run, signal) {
    if (!run?.child || typeof terminateChildProcess !== 'function') return;
    terminateChildProcess(run.child, signal);
  }

  function clearRunTimers(run) {
    if (run.postFinalKillTimer) {
      clearTimeout(run.postFinalKillTimer);
      run.postFinalKillTimer = null;
    }
    if (run.postFinalForceKillTimer) {
      clearTimeout(run.postFinalForceKillTimer);
      run.postFinalForceKillTimer = null;
    }
  }

  function cancelActiveRuns({ reason = 'shutdown' } = {}) {
    let cancelledRuns = 0;
    for (const run of activeRuns) {
      cancelledRuns += 1;
      clearRunTimers(run);
      if (typeof run.stop === 'function') {
        Promise.resolve(run.stop({ reason })).catch((err) => {
          console.warn('Failed to stop active run:', err);
        });
      } else {
        scheduleRunTermination(run, 'SIGTERM');
        run.postFinalForceKillTimer = setTimeout(() => {
          scheduleRunTermination(run, 'SIGKILL');
        }, 1000);
        if (typeof run.postFinalForceKillTimer.unref === 'function') {
          run.postFinalForceKillTimer.unref();
        }
      }
    }
    if (cancelledRuns > 0) {
      console.info(
        `cancel_active_runs reason=${reason} count=${cancelledRuns}`
      );
    }
    return cancelledRuns;
  }

  async function stopActiveRun(chatId, topicId, overrideAgentId) {
    const effectiveAgentId = resolveEffectiveAgentId(
      chatId,
      topicId,
      overrideAgentId
    );
    const run = activeRunsByKey.get(
      buildActiveRunKey(chatId, topicId, effectiveAgentId)
    );
    if (!run || run.settled) {
      return { status: 'idle', agentId: effectiveAgentId };
    }
    if (typeof run.stop !== 'function') {
      return { status: 'unsupported', agentId: effectiveAgentId };
    }
    if (run.stopPending) {
      return { status: 'stopping', agentId: effectiveAgentId };
    }
    run.stopPending = true;
    const result = await run.stop({ reason: 'user' });
    if (result?.status === 'not_ready') {
      run.stopRequested = true;
      run.stopPending = false;
      return { status: 'queued', agentId: effectiveAgentId };
    }
    return { status: 'stopping', agentId: effectiveAgentId };
  }

  async function steerActiveRun(chatId, topicId, text, overrideAgentId) {
    const effectiveAgentId = resolveEffectiveAgentId(
      chatId,
      topicId,
      overrideAgentId
    );
    const run = activeRunsByKey.get(
      buildActiveRunKey(chatId, topicId, effectiveAgentId)
    );
    if (!run || run.settled || run.finalEmitted) {
      return { status: 'idle', agentId: effectiveAgentId };
    }
    if (typeof run.steer !== 'function') {
      return { status: 'unsupported', agentId: effectiveAgentId };
    }
    return run.steer({ text });
  }

  function getActiveRunState(chatId, topicId, overrideAgentId) {
    const effectiveAgentId = resolveEffectiveAgentId(
      chatId,
      topicId,
      overrideAgentId
    );
    const run = activeRunsByKey.get(
      buildActiveRunKey(chatId, topicId, effectiveAgentId)
    );
    if (!run || run.settled) {
      return {
        active: false,
        agentId: effectiveAgentId,
      };
    }
    return {
      active: true,
      agentId: effectiveAgentId,
      finalEmitted: Boolean(run.finalEmitted),
      lifecycleState: run.lifecycleState,
      stopPending: Boolean(run.stopPending),
      stopRequested: Boolean(run.stopRequested),
      threadId: run.session?.threadId,
      turnId: run.session?.turnId,
    };
  }

  async function runAgentOneShot(prompt) {
    const globalAgent = getGlobalAgent();
    const agent = getAgent(globalAgent);
    const thinking = getGlobalThinking();
    const model = getGlobalModels()[globalAgent];
    let promptText = String(prompt || '');
    if (agent.id === 'claude') {
      promptText = prefixTextWithTimestamp(promptText, {
        timeZone: defaultTimeZone,
      });
    }

    if (
      agent.backend === 'app-server'
      && typeof runSessionBackedOneShot === 'function'
    ) {
      console.info(`Agent one-shot start agent=${getAgentLabel(globalAgent)}`);
      const startedAt = Date.now();
      try {
        const result = await runSessionBackedOneShot({
          agentId: agent.id,
          effort: thinking,
          model,
          prompt: promptText,
        });
        return String(result?.text || '').trim();
      } finally {
        const elapsedMs = Date.now() - startedAt;
        console.info(`Agent one-shot finished durationMs=${elapsedMs}`);
      }
    }

    const promptBase64 = Buffer.from(promptText, 'utf8').toString('base64');
    const promptExpression = '"$PROMPT"';
    const agentCmd = agent.buildCommand({
      prompt: promptText,
      promptExpression,
      threadId: undefined,
      model,
      thinking,
    });

    const command = [
      `PROMPT_B64=${shellQuote(promptBase64)};`,
      'PROMPT=$(printf %s "$PROMPT_B64" | base64 --decode);',
      `${agentCmd}`,
    ].join(' ');

    let commandToRun = command;
    if (agent.needsPty) {
      commandToRun = wrapCommandWithPty(commandToRun);
    }
    if (agent.mergeStderr) {
      commandToRun = `${commandToRun} 2>&1`;
    }

    const startedAt = Date.now();
    console.info(`Agent one-shot start agent=${getAgentLabel(globalAgent)}`);
    let output;
    let execError;
    try {
      output = await execLocal('bash', ['-lc', commandToRun], {
        timeout: agentTimeoutMs,
        maxBuffer: agentMaxBuffer,
      });
    } catch (err) {
      execError = err;
      if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
        output = err.stdout;
      } else {
        throw err;
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.info(`Agent one-shot finished durationMs=${elapsedMs}`);
    }

    const parsed = agent.parseOutput(output);
    if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
      throw execError;
    }
    if (execError) {
      console.warn(
        `Agent one-shot exited non-zero; returning stdout (code=${execError.code || 'unknown'})`
      );
    }
    return parsed.text || output;
  }

  async function runAgentForChat(chatId, prompt, runOptions = {}) {
    const {
      topicId,
      contextKey,
      agentId: overrideAgentId,
      imagePaths,
      scriptContext,
      documentPaths,
      onFinalResponse,
      onProgressUpdate,
      onSettled,
    } = runOptions;
    const effectiveAgentId = resolveEffectiveAgentId(
      chatId,
      topicId,
      overrideAgentId
    );
    const originalPrompt = String(prompt || '').trim();
    const agent = getAgent(effectiveAgentId);

    const threads = getThreads();
    const { threadKey, threadId, migrated } = resolveThreadId(
      threads,
      chatId,
      topicId,
      effectiveAgentId,
      contextKey
    );
    const turnCount = (threadTurns.get(threadKey) || 0) + 1;
    threadTurns.set(threadKey, turnCount);
    const shouldIncludeFileInstructions =
      !threadId || turnCount % fileInstructionsEvery === 0;
    if (migrated) {
      persistThreads().catch((err) =>
        console.warn('Failed to persist migrated threads:', err)
      );
    }

    let promptWithContext = prompt;
    if (agent.id === 'claude') {
      promptWithContext = prefixTextWithTimestamp(promptWithContext, {
        timeZone: defaultTimeZone,
      });
    }
    if (!threadId) {
      const bootstrap = await buildBootstrapContext({
        includeMemory: !(agent.backend === 'app-server' && agent.id === 'codex-app'),
        includeSoul: !(agent.backend === 'app-server' && agent.id === 'codex-app'),
        includeThreadMemory: false,
        includeTools: !(agent.backend === 'app-server' && agent.id === 'codex-app'),
        threadKey,
      });
      promptWithContext = promptWithContext
        ? `${bootstrap}\n\n${promptWithContext}`
        : bootstrap;
    }
    const thinking = getGlobalThinking();
    const model = getGlobalModels()[effectiveAgentId];
    const finalPrompt = buildPrompt(
      promptWithContext,
      imagePaths || [],
      imageDir,
      scriptContext,
      documentPaths || [],
      documentDir,
      {
        agentId: effectiveAgentId,
        includeFileInstructions: shouldIncludeFileInstructions,
        currentDate: new Date(),
        defaultTimeZone,
        model,
      }
    );
    const promptBase64 = Buffer.from(finalPrompt, 'utf8').toString('base64');
    const promptExpression = '"$PROMPT"';
    const agentCmd =
      agent.backend === 'app-server'
        ? null
        : agent.buildCommand({
          prompt: finalPrompt,
          promptExpression,
          threadId,
          thinking,
          model,
        });
    const command = agentCmd
      ? [
        `PROMPT_B64=${shellQuote(promptBase64)};`,
        'PROMPT=$(printf %s "$PROMPT_B64" | base64 --decode);',
        `${agentCmd}`,
      ].join(' ')
      : '';
    let commandToRun = command;
    if (agentCmd && agent.needsPty) {
      commandToRun = wrapCommandWithPty(commandToRun);
    }
    if (agentCmd && agent.mergeStderr) {
      commandToRun = `${commandToRun} 2>&1`;
    }

    const startedAt = Date.now();
    console.info(
      `Agent start chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} thread=${threadId || 'new'}`
    );
    const run = {
      activeKey: buildActiveRunKey(chatId, topicId, effectiveAgentId, contextKey),
      child: null,
      droppedProgressUpdates: 0,
      finalEmitted: false,
      lifecycleState: 'streaming',
      pendingSteers: [],
      postFinalForceKillTimer: null,
      postFinalKillTimer: null,
      session: null,
      settled: false,
      steer:
        agent.backend === 'app-server'
          ? async () => ({ status: 'unsupported' })
          : null,
      steerChain: Promise.resolve(),
      stop:
        agent.backend === 'app-server'
          ? async () => ({ status: 'not_ready' })
          : null,
      stopPending: false,
      stopRequested: false,
    };
    trackActiveRun(run);
    let output;
    let execError;
    let fatalError = null;
    let streamedOutput = '';
    let streamedThreadId;
    let streamedFinalText;
    let lastProgressFingerprint = '';
    let finalSignalLogged = false;

    const emitSettled = async (status) => {
      if (typeof onSettled !== 'function') return;
      try {
        await Promise.resolve(
          onSettled({
            chatId,
            topicId,
            agentId: effectiveAgentId,
            droppedProgressUpdates: run.droppedProgressUpdates,
            finalEmitted: run.finalEmitted,
            state: run.lifecycleState,
            status,
          })
        );
      } catch (err) {
        console.warn('Failed to run onSettled callback:', err);
      }
    };

    const schedulePostFinalKill = () => {
      if (
        run.settled
        || run.postFinalKillTimer
        || !run.finalEmitted
        || !run.child
        || typeof terminateChildProcess !== 'function'
      ) {
        return;
      }

      const delayMs = Math.max(0, Number(postFinalGraceMs) || 0);
      run.postFinalKillTimer = setTimeout(() => {
        if (run.settled || !run.child) return;
        console.warn(
          `post_final_kill chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} delay_ms=${delayMs}`
        );
        scheduleRunTermination(run, 'SIGTERM');
        run.postFinalForceKillTimer = setTimeout(() => {
          if (run.settled || !run.child) return;
          scheduleRunTermination(run, 'SIGKILL');
        }, 1000);
        if (typeof run.postFinalForceKillTimer.unref === 'function') {
          run.postFinalForceKillTimer.unref();
        }
      }, delayMs);
      if (typeof run.postFinalKillTimer.unref === 'function') {
        run.postFinalKillTimer.unref();
      }
    };

    const emitFinalResponse = (text) => {
      const normalizedText = String(text || '').trim();
      if (!normalizedText || run.finalEmitted) return;
      run.finalEmitted = true;
      run.lifecycleState = 'final_emitted';
      streamedFinalText = normalizedText;
      console.info(
        `final_emitted chat=${chatId} topic=${topicId || 'root'} agent=${agent.id}`
      );
      schedulePostFinalKill();
      if (typeof onFinalResponse === 'function') {
        Promise.resolve(onFinalResponse(normalizedText)).catch((err) => {
          console.warn('Failed to stream final agent response:', err);
        });
      }
    };

    const emitProgressUpdate = (payload) => {
      if (typeof onProgressUpdate !== 'function') return;
      const fingerprint = Array.isArray(payload)
        ? payload.join('\n')
        : payload && typeof payload === 'object'
          ? JSON.stringify(payload)
          : String(payload || '');
      const hasContent = Array.isArray(payload)
        ? payload.length > 0
        : Boolean(
          (payload && typeof payload === 'object' && String(payload.text || '').trim())
          || String(payload || '').trim()
        );
      if (run.finalEmitted) {
        if (hasContent) {
          run.droppedProgressUpdates += 1;
        }
        return;
      }
      if (!fingerprint || fingerprint === lastProgressFingerprint) return;
      lastProgressFingerprint = fingerprint;
      Promise.resolve(onProgressUpdate(payload)).catch((err) => {
        console.warn('Failed to stream agent progress update:', err);
      });
    };

    if (
      agent.backend === 'app-server'
      && typeof runSessionBackedChatTurn === 'function'
    ) {
      try {
        const buildThreadTitle = () => {
          const clean = (value) =>
            String(value || '')
              .replace(/\s+/g, ' ')
              .replace(/\[\[(image|document):[^\]]+\]\]/gi, '')
              .trim();
          const candidates = [
            originalPrompt,
            imagePaths?.length ? 'Imagen adjunta' : '',
            documentPaths?.length ? 'Documento adjunto' : '',
            scriptContext ? 'Salida de script' : '',
          ];
          for (const candidate of candidates) {
            const normalized = clean(candidate);
            if (!normalized) continue;
            return normalized.length <= 80
              ? normalized
              : `${normalized.slice(0, 79).trimEnd()}…`;
          }
          return '';
        };

        const sendSteer = ({ text }) => {
          const normalizedText = String(text || '').trim();
          if (!normalizedText) {
            return Promise.resolve({
              status: 'ignored',
              agentId: agent.id,
            });
          }
          if (run.settled || run.finalEmitted) {
            return Promise.resolve({
              status: 'idle',
              agentId: agent.id,
            });
          }
          if (run.stopRequested || run.stopPending) {
            return Promise.resolve({
              status: 'stopping',
              agentId: agent.id,
            });
          }
          if (
            typeof steerSessionBackedTurn !== 'function'
            || !run.session?.threadId
            || !run.session?.turnId
          ) {
            run.pendingSteers.push(normalizedText);
            return Promise.resolve({
              status: 'queued',
              agentId: agent.id,
            });
          }
          run.steerChain = run.steerChain.then(async () => {
            await steerSessionBackedTurn({
              agentId: agent.id,
              input: [{ type: 'text', text: normalizedText }],
              threadId: run.session.threadId,
              turnId: run.session.turnId,
            });
          });
          return run.steerChain.then(() => ({
            status: 'steered',
            agentId: agent.id,
          }));
        };

        const flushPendingSteers = () => {
          if (
            run.settled
            || run.finalEmitted
            || run.stopRequested
            || run.stopPending
            || run.pendingSteers.length === 0
          ) {
            return;
          }
          const queuedTexts = run.pendingSteers.splice(0);
          for (const pendingText of queuedTexts) {
            void sendSteer({ text: pendingText }).catch((err) => {
              console.warn('Failed to flush queued steer input:', err);
            });
          }
        };

        run.steer = sendSteer;
        run.stop = async () => {
          if (
            typeof stopSessionBackedTurn !== 'function'
            || !run.session?.threadId
            || !run.session?.turnId
          ) {
            return { status: 'not_ready' };
          }
          run.stopRequested = true;
          run.lifecycleState = 'interrupting';
          await stopSessionBackedTurn({
            agentId: agent.id,
            threadId: run.session.threadId,
            turnId: run.session.turnId,
          });
          return { status: 'stopping' };
        };
        const result = await runSessionBackedChatTurn({
          agentId: agent.id,
          chatId,
          cwd: process.cwd(),
          documentPaths: documentPaths || [],
          effort: thinking,
          imagePaths: imagePaths || [],
          model,
          onFinalResponse: emitFinalResponse,
          onProgressUpdate: emitProgressUpdate,
          onTurnStarted: ({ threadId: activeThreadId, turnId: activeTurnId }) => {
            run.session = {
              threadId: String(activeThreadId),
              turnId: String(activeTurnId),
            };
            if (run.stopRequested && !run.stopPending && !run.settled) {
              run.stopPending = true;
              Promise.resolve(run.stop({ reason: 'user' })).catch((err) => {
                run.stopPending = false;
                console.warn('Failed to stop run after startup:', err);
              });
              return;
            }
            flushPendingSteers();
          },
          prompt: finalPrompt,
          topicId,
          threadId,
        });
        if (result?.threadId && result?.turnId) {
          run.session = {
            threadId: String(result.threadId),
            turnId: String(result.turnId),
          };
        }
        if (result?.threadId) {
          threads.set(threadKey, result.threadId);
          persistThreads().catch((err) =>
            console.warn('Failed to persist threads:', err)
          );
          if (!threadId && typeof setSessionBackedThreadTitle === 'function') {
            const title = buildThreadTitle();
            if (title) {
              Promise.resolve(
                setSessionBackedThreadTitle({
                  agentId: agent.id,
                  threadId: result.threadId,
                  title,
                })
              ).catch((err) => {
                console.warn('Failed to set session-backed thread title:', err);
              });
            }
          }
        }
        if (result?.text) {
          emitFinalResponse(result.text);
        }
        run.settled = true;
        run.lifecycleState = 'settled';
        clearRunTimers(run);
        untrackActiveRun(run);
        console.info(
          `run_settled chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} final_emitted=${run.finalEmitted} dropped_progress_updates=${run.droppedProgressUpdates}`
        );
        await emitSettled('succeeded');
        return String(result?.text || '').trim();
      } catch (err) {
        run.settled = true;
        run.lifecycleState =
          err?.code === 'ERR_RUN_INTERRUPTED' ? 'interrupted' : 'failed';
        clearRunTimers(run);
        untrackActiveRun(run);
        await emitSettled(
          err?.code === 'ERR_RUN_INTERRUPTED' ? 'interrupted' : 'failed'
        );
        throw err;
      }
    }

    const canStreamFinal =
      (typeof onFinalResponse === 'function' || typeof onProgressUpdate === 'function')
      && typeof execLocalStreaming === 'function'
      && typeof agent.parseStreamingOutput === 'function';
    try {
      if (canStreamFinal) {
        output = await execLocalStreaming('bash', ['-lc', commandToRun], {
          timeout: agentTimeoutMs,
          maxBuffer: agentMaxBuffer,
          onSpawn: (child) => {
            run.child = child;
            schedulePostFinalKill();
          },
          onStdout: (chunk) => {
            streamedOutput += chunk;
            const partial = agent.parseStreamingOutput(streamedOutput);
            if (partial.threadId) {
              streamedThreadId = partial.threadId;
            }
            if (
              typeof onProgressUpdate === 'function'
              && Array.isArray(partial.commentaryMessages)
            ) {
              const fingerprint = partial.commentaryMessages.join('\n');
              if (fingerprint) {
                emitProgressUpdate(partial.commentaryMessages);
              }
            }
            if (partial.sawFinal && partial.text) {
              emitFinalResponse(partial.text);
            }
          },
        });
      } else {
        output = await execLocal('bash', ['-lc', commandToRun], {
          timeout: agentTimeoutMs,
          maxBuffer: agentMaxBuffer,
        });
      }
    } catch (err) {
      execError = err;
      if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
        output = err.stdout;
      } else if (run.finalEmitted && streamedFinalText) {
        output = streamedOutput || streamedFinalText;
      } else {
        fatalError = err;
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.info(
        `Agent finished chat=${chatId} topic=${topicId || 'root'} durationMs=${elapsedMs}`
      );
    }
    if (fatalError) {
      run.settled = true;
      run.lifecycleState = 'failed';
      clearRunTimers(run);
      untrackActiveRun(run);
      await emitSettled('failed');
      throw fatalError;
    }
    const parsed = agent.parseOutput(output);
    if (!parsed.threadId && streamedThreadId) {
      parsed.threadId = streamedThreadId;
    }
    if (!parsed.text && streamedFinalText) {
      parsed.text = streamedFinalText;
    }
    if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
      run.settled = true;
      run.lifecycleState = 'failed';
      clearRunTimers(run);
      untrackActiveRun(run);
      await emitSettled('failed');
      throw execError;
    }
    if (execError) {
      if (run.finalEmitted && String(parsed.text || '').trim()) {
        finalSignalLogged = true;
      } else {
        console.warn(
          `Agent exited non-zero; returning stdout chat=${chatId} topic=${topicId || 'root'} code=${execError.code || 'unknown'}`
        );
      }
    }
    if (!parsed.threadId && typeof agent.listSessionsCommand === 'function') {
      try {
        const listCommand = agent.listSessionsCommand();
        let listCommandToRun = listCommand;
        if (agent.needsPty) {
          listCommandToRun = wrapCommandWithPty(listCommandToRun);
        }
        if (agent.mergeStderr) {
          listCommandToRun = `${listCommandToRun} 2>&1`;
        }
        const listOutput = await execLocal('bash', ['-lc', listCommandToRun], {
          timeout: agentTimeoutMs,
          maxBuffer: agentMaxBuffer,
        });
        if (typeof agent.parseSessionList === 'function') {
          const resolved = agent.parseSessionList(listOutput);
          if (resolved) {
            parsed.threadId = resolved;
          }
        }
      } catch (err) {
        console.warn('Failed to resolve agent session id:', err?.message || err);
      }
    }
    if (parsed.threadId) {
      threads.set(threadKey, parsed.threadId);
      persistThreads().catch((err) =>
        console.warn('Failed to persist threads:', err)
      );
    }
    run.settled = true;
    run.lifecycleState = 'settled';
    clearRunTimers(run);
    untrackActiveRun(run);
    console.info(
      `run_settled chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} final_emitted=${run.finalEmitted} dropped_progress_updates=${run.droppedProgressUpdates}${finalSignalLogged ? ' post_final_exit=true' : ''}`
    );
    await emitSettled('succeeded');
    return parsed.text || output;
  }

  return {
    cancelActiveRuns,
    getActiveRunState,
    runAgentForChat,
    runAgentOneShot,
    steerActiveRun,
    stopActiveRun,
  };
}

module.exports = {
  createAgentRunner,
};

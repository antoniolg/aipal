function createAgentRunner(options) {
  const {
    agentMaxBuffer,
    agentTimeoutMs,
    buildBootstrapContext,
    buildMemoryRetrievalContext,
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
    memoryRetrievalLimit,
    persistThreads,
    postFinalGraceMs = 2500,
    prefixTextWithTimestamp,
    resolveEffectiveAgentId,
    resolveThreadId,
    shellQuote,
    terminateChildProcess,
    threadTurns,
    wrapCommandWithPty,
    defaultTimeZone,
  } = options;
  const activeRuns = new Set();

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
      scheduleRunTermination(run, 'SIGTERM');
      run.postFinalForceKillTimer = setTimeout(() => {
        scheduleRunTermination(run, 'SIGKILL');
      }, 1000);
      if (typeof run.postFinalForceKillTimer.unref === 'function') {
        run.postFinalForceKillTimer.unref();
      }
    }
    if (cancelledRuns > 0) {
      console.info(
        `cancel_active_runs reason=${reason} count=${cancelledRuns}`
      );
    }
    return cancelledRuns;
  }

  async function runAgentOneShot(prompt) {
    const globalAgent = getGlobalAgent();
    const agent = getAgent(globalAgent);
    const thinking = getGlobalThinking();
    let promptText = String(prompt || '');
    if (agent.id === 'claude') {
      promptText = prefixTextWithTimestamp(promptText, {
        timeZone: defaultTimeZone,
      });
    }
    const promptBase64 = Buffer.from(promptText, 'utf8').toString('base64');
    const promptExpression = '"$PROMPT"';
    const agentCmd = agent.buildCommand({
      prompt: promptText,
      promptExpression,
      threadId: undefined,
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
    const agent = getAgent(effectiveAgentId);

    const threads = getThreads();
    const { threadKey, threadId, migrated } = resolveThreadId(
      threads,
      chatId,
      topicId,
      effectiveAgentId
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
      const bootstrap = await buildBootstrapContext({ threadKey });
      promptWithContext = promptWithContext
        ? `${bootstrap}\n\n${promptWithContext}`
        : bootstrap;
    }
    const retrievalContext = await buildMemoryRetrievalContext({
      query: prompt,
      chatId,
      topicId,
      agentId: effectiveAgentId,
      limit: memoryRetrievalLimit,
    });
    if (retrievalContext) {
      promptWithContext = promptWithContext
        ? `${promptWithContext}\n\n${retrievalContext}`
        : retrievalContext;
    }

    const thinking = getGlobalThinking();
    const finalPrompt = buildPrompt(
      promptWithContext,
      imagePaths || [],
      imageDir,
      scriptContext,
      documentPaths || [],
      documentDir,
      {
        includeFileInstructions: shouldIncludeFileInstructions,
        currentDate: new Date(),
        defaultTimeZone,
      }
    );
    const promptBase64 = Buffer.from(finalPrompt, 'utf8').toString('base64');
    const promptExpression = '"$PROMPT"';
    const agentCmd = agent.buildCommand({
      prompt: finalPrompt,
      promptExpression,
      threadId,
      thinking,
      model: getGlobalModels()[effectiveAgentId],
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
    console.info(
      `Agent start chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} thread=${threadId || 'new'}`
    );
    const run = {
      child: null,
      droppedProgressUpdates: 0,
      finalEmitted: false,
      lifecycleState: 'streaming',
      postFinalForceKillTimer: null,
      postFinalKillTimer: null,
      settled: false,
    };
    activeRuns.add(run);
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

    const emitProgressLines = (lines) => {
      if (typeof onProgressUpdate !== 'function' || !Array.isArray(lines)) return;
      if (run.finalEmitted) {
        if (lines.length > 0) {
          run.droppedProgressUpdates += 1;
        }
        return;
      }
      const fingerprint = lines.join('\n');
      if (!fingerprint || fingerprint === lastProgressFingerprint) return;
      lastProgressFingerprint = fingerprint;
      Promise.resolve(onProgressUpdate(lines)).catch((err) => {
        console.warn('Failed to stream agent progress update:', err);
      });
    };
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
                emitProgressLines(partial.commentaryMessages);
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
      activeRuns.delete(run);
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
      activeRuns.delete(run);
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
    activeRuns.delete(run);
    console.info(
      `run_settled chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} final_emitted=${run.finalEmitted} dropped_progress_updates=${run.droppedProgressUpdates}${finalSignalLogged ? ' post_final_exit=true' : ''}`
    );
    await emitSettled('succeeded');
    return parsed.text || output;
  }

  return {
    cancelActiveRuns,
    runAgentForChat,
    runAgentOneShot,
  };
}

module.exports = {
  createAgentRunner,
};

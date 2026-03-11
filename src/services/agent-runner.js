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
    prefixTextWithTimestamp,
    resolveEffectiveAgentId,
    resolveThreadId,
    shellQuote,
    threadTurns,
    wrapCommandWithPty,
    defaultTimeZone,
  } = options;

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
    } =
      runOptions;
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
    let output;
    let execError;
    let streamedOutput = '';
    let streamedThreadId;
    let streamedFinalText;
    let streamedFinalDelivered = false;
    let lastProgressFingerprint = '';
    const canStreamFinal =
      (typeof onFinalResponse === 'function' || typeof onProgressUpdate === 'function')
      && typeof execLocalStreaming === 'function'
      && typeof agent.parseStreamingOutput === 'function';
    try {
      if (canStreamFinal) {
        output = await execLocalStreaming('bash', ['-lc', commandToRun], {
          timeout: agentTimeoutMs,
          maxBuffer: agentMaxBuffer,
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
              if (fingerprint && fingerprint !== lastProgressFingerprint) {
                lastProgressFingerprint = fingerprint;
                Promise.resolve(onProgressUpdate(partial.commentaryMessages)).catch(
                  (err) => {
                    console.warn('Failed to stream agent progress update:', err);
                  }
                );
              }
            }
            if (
              partial.sawFinal
              && partial.text
              && !streamedFinalDelivered
            ) {
              streamedFinalDelivered = true;
              streamedFinalText = partial.text;
              Promise.resolve(onFinalResponse(partial.text)).catch((err) => {
                console.warn('Failed to stream final agent response:', err);
              });
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
      } else {
        throw err;
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.info(
        `Agent finished chat=${chatId} topic=${topicId || 'root'} durationMs=${elapsedMs}`
      );
    }
    const parsed = agent.parseOutput(output);
    if (!parsed.threadId && streamedThreadId) {
      parsed.threadId = streamedThreadId;
    }
    if (!parsed.text && streamedFinalText) {
      parsed.text = streamedFinalText;
    }
    if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
      throw execError;
    }
    if (execError) {
      console.warn(
        `Agent exited non-zero; returning stdout chat=${chatId} topic=${topicId || 'root'} code=${execError.code || 'unknown'}`
      );
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
    return parsed.text || output;
  }

  return {
    runAgentForChat,
    runAgentOneShot,
  };
}

module.exports = {
  createAgentRunner,
};

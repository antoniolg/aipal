function registerSettingsCommands(options) {
  const {
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
    getGlobalModels,
    getGlobalServiceTiers,
    getGlobalThinking,
    getTopicId,
    isKnownAgent,
    listAgentModels,
    isModelResetCommand,
    normalizeAgent,
    normalizeTopicId,
    persistAgentOverrides,
    persistMemory,
    persistThreads,
    replyWithError,
    setAgentOverride,
    setGlobalAgent,
    setGlobalModels,
    setGlobalServiceTiers,
    setGlobalThinking,
    setMemoryEventsSinceCurate,
    startTyping,
    threadTurns,
    updateConfig,
    wrapCommandWithPty,
  } = options;

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
      ctx.reply('Unknown agent. Use /agent codex|codex-app|claude|gemini|opencode.');
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
    const topicId = getTopicId(ctx);
    const value = extractCommandValue(ctx.message.text);
    const currentAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();
    const agent = getAgent(currentAgentId);

    if (!value) {
      const current = getGlobalModels()[currentAgentId] || agent.defaultModel || '(default)';
      let msg = `Current model for ${agent.label}: ${current}. Use /model <model_id> to change or /model reset to clear.`;

      if (
        typeof listAgentModels === 'function'
        || typeof agent.listModelsCommand === 'function'
      ) {
        const stopTyping = startTyping(ctx);
        try {
          let modelsList = '';
          if (typeof listAgentModels === 'function') {
            modelsList = await listAgentModels(currentAgentId);
          } else {
            const cmd = agent.listModelsCommand();
            let cmdToRun = cmd;
            if (agent.needsPty) cmdToRun = wrapCommandWithPty(cmdToRun);

            const output = await execLocal('bash', ['-lc', cmdToRun], {
              timeout: 30000,
            });

            modelsList = output.trim();
            if (typeof agent.parseModelList === 'function') {
              modelsList = agent.parseModelList(modelsList);
            }
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

  bot.command('fast', async (ctx) => {
    const topicId = getTopicId(ctx);
    const currentAgentId =
      getAgentOverride(ctx.chat.id, topicId) || getGlobalAgent();

    if (currentAgentId !== 'codex-app') {
      await ctx.reply('/fast is only supported for codex-app.');
      return;
    }

    try {
      const currentTier = getGlobalServiceTiers()?.[currentAgentId] || 'flex';
      const nextTier = currentTier === 'fast' ? 'flex' : 'fast';
      const nextServiceTiers = {
        ...(getGlobalServiceTiers() || {}),
        [currentAgentId]: nextTier,
      };
      setGlobalServiceTiers(nextServiceTiers);
      await updateConfig({ serviceTiers: getGlobalServiceTiers() });

      await ctx.reply(
        nextTier === 'fast'
          ? 'codex-app now uses service tier fast.'
          : 'codex-app now uses service tier flex.'
      );
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Failed to persist fast mode setting.', err);
    }
  });
}

module.exports = {
  registerSettingsCommands,
};

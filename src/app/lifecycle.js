function initializeApp(options) {
  const {
    handleCronTrigger,
    notifyCronAlert,
    hydrateGlobalSettings,
    loadAgentOverrides,
    loadThreads,
    setAgentOverrides,
    setCronDefaultChatId,
    setCronScheduler,
    setThreads,
    startCronScheduler,
    startDocumentCleanup,
    startImageCleanup,
    startHttpServer,
  } = options;

  startImageCleanup();
  startDocumentCleanup();

  if (startHttpServer) {
    startHttpServer();
  }

  loadThreads()
    .then((loaded) => {
      setThreads(loaded);
      console.info(`Loaded ${loaded.size} thread(s) from disk`);
    })
    .catch((err) => console.warn('Failed to load threads:', err));

  loadAgentOverrides()
    .then((loaded) => {
      setAgentOverrides(loaded);
      console.info(`Loaded ${loaded.size} agent override(s) from disk`);
    })
    .catch((err) => console.warn('Failed to load agent overrides:', err));

  hydrateGlobalSettings()
    .then((config) => {
      const cronDefaultChatId = config.cronChatId || null;
      setCronDefaultChatId(cronDefaultChatId);
      if (cronDefaultChatId) {
        setCronScheduler(
          startCronScheduler({
            chatId: cronDefaultChatId,
            onAlert: notifyCronAlert,
            onTrigger: handleCronTrigger,
          })
        );
      } else {
        console.info('Cron scheduler disabled (no cronChatId in config)');
      }
    })
    .catch((err) => console.warn('Failed to load config settings:', err));
}

function installShutdownHooks(options) {
  const {
    bot,
    getCronScheduler,
    getPersistPromises,
    getQueues,
    shutdownDrainTimeoutMs,
    stopHttpServer,
  } = options;

  let shutdownStarted = false;

  function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.info(`Shutting down (${signal})...`);

    try {
      const cronScheduler = getCronScheduler();
      if (cronScheduler && typeof cronScheduler.stop === 'function') {
        cronScheduler.stop();
      }
    } catch (err) {
      console.warn('Failed to stop cron scheduler:', err);
    }

    try {
      if (stopHttpServer) {
        stopHttpServer().catch((err) => console.warn('Failed to stop HTTP server:', err));
      }
    } catch (err) {
      console.warn('Failed to trigger HTTP server stop:', err);
    }

    try {
      bot.stop(signal);
    } catch (err) {
      console.warn('Failed to stop bot:', err);
    }

    const forceTimer = setTimeout(() => {
      console.warn('Forcing process exit after shutdown timeout.');
      process.exit(0);
    }, shutdownDrainTimeoutMs + 2000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    Promise.resolve()
      .then(async () => {
        const pending = Array.from(getQueues().values());
        if (pending.length > 0) {
          console.info(`Waiting for ${pending.length} queued job(s) to finish...`);
          await Promise.race([
            Promise.allSettled(pending),
            new Promise((resolve) => setTimeout(resolve, shutdownDrainTimeoutMs)),
          ]);
        }
        await Promise.race([
          Promise.allSettled(getPersistPromises()),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      })
      .catch((err) => {
        console.warn('Error during shutdown drain:', err);
      })
      .finally(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      });
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return shutdown;
}

module.exports = {
  initializeApp,
  installShutdownHooks,
};

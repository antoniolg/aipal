function bootstrapApp(options) {
  const { bot, initializeApp, installShutdownHooks } = options;

  initializeApp();
  const dropPendingUpdates = process.env.AIPAL_DROP_PENDING_UPDATES !== 'false';
  console.info(`Launching Telegram bot (dropPendingUpdates=${dropPendingUpdates})`);
  if (!dropPendingUpdates) {
    console.warn(
      'AIPAL_DROP_PENDING_UPDATES=false may replay stale Telegram updates from before restart.'
    );
  }
  bot.launch({ dropPendingUpdates });
  installShutdownHooks();
}

module.exports = {
  bootstrapApp,
};

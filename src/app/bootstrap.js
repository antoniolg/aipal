function bootstrapApp(options) {
  const { bot, initializeApp, installShutdownHooks, syncBotCommands } = options;

  initializeApp();
  Promise.resolve(bot.launch())
    .then(async () => {
      if (typeof syncBotCommands === 'function') {
        await syncBotCommands();
      }
    })
    .catch((err) => {
      console.error('Failed to launch bot:', err);
      process.exit(1);
    });
  installShutdownHooks();
}

module.exports = {
  bootstrapApp,
};

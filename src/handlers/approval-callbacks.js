function registerApprovalCallbacks(options) {
  const { bot, handleCallbackQuery } = options;
  if (!bot || typeof handleCallbackQuery !== 'function') return;

  bot.on('callback_query', async (ctx, next) => {
    const handled = await handleCallbackQuery(ctx);
    if (handled) return;
    return next();
  });
}

module.exports = {
  registerApprovalCallbacks,
};

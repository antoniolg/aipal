function registerApprovalCallbacks(options) {
  const { bot, handleApprovalCallback } = options;
  if (!bot || typeof handleApprovalCallback !== 'function') return;

  bot.on('callback_query', async (ctx, next) => {
    const handled = await handleApprovalCallback(ctx);
    if (handled) return;
    return next();
  });
}

module.exports = {
  registerApprovalCallbacks,
};

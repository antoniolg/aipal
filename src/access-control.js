function parseAllowedUsersEnv(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => String(value))
  );
}

function createAccessControlMiddleware(allowedUserIds, options = {}) {
  const allowed =
    allowedUserIds instanceof Set ? allowedUserIds : new Set(allowedUserIds || []);
  const onUnauthorized =
    typeof options.onUnauthorized === 'function' ? options.onUnauthorized : () => {};

  return (ctx, next) => {
    const userId = String(ctx?.from?.id ?? '');
    if (!userId || !allowed.has(userId)) {
      onUnauthorized({ userId, username: ctx?.from?.username });
      return;
    }
    return next();
  };
}

module.exports = {
  createAccessControlMiddleware,
  parseAllowedUsersEnv,
};


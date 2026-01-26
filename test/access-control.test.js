const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAccessControlMiddleware,
  parseAllowedUsersEnv,
} = require('../src/access-control');

test('parseAllowedUsersEnv parses comma-separated user IDs', () => {
  const allowed = parseAllowedUsersEnv(' 123, ,456 ,789 ');
  assert.equal(allowed.size, 3);
  assert.equal(allowed.has('123'), true);
  assert.equal(allowed.has('456'), true);
  assert.equal(allowed.has('789'), true);
});

test('access control middleware drops unauthorized updates', async () => {
  let calledNext = 0;
  let unauthorizedPayload;
  const allowed = new Set(['1']);
  const middleware = createAccessControlMiddleware(allowed, {
    onUnauthorized: (payload) => {
      unauthorizedPayload = payload;
    },
  });

  const ctx = { from: { id: 2, username: 'evil' } };
  await middleware(ctx, async () => {
    calledNext += 1;
  });

  assert.equal(calledNext, 0);
  assert.deepEqual(unauthorizedPayload, { userId: '2', username: 'evil' });
});

test('access control middleware allows authorized updates', async () => {
  let calledNext = 0;
  const allowed = new Set(['2']);
  const middleware = createAccessControlMiddleware(allowed, {
    onUnauthorized: () => {
      throw new Error('should not be called');
    },
  });

  const ctx = { from: { id: 2, username: 'ok' } };
  await middleware(ctx, async () => {
    calledNext += 1;
  });

  assert.equal(calledNext, 1);
});

test('access control middleware handles missing ctx.from', async () => {
  let calledNext = 0;
  let unauthorizedPayload;
  const allowed = new Set(['2']);
  const middleware = createAccessControlMiddleware(allowed, {
    onUnauthorized: (payload) => {
      unauthorizedPayload = payload;
    },
  });

  await middleware({}, async () => {
    calledNext += 1;
  });

  assert.equal(calledNext, 0);
  assert.deepEqual(unauthorizedPayload, { userId: '', username: undefined });
});


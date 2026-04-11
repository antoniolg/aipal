const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTimestampPrefix, prefixTextWithTimestamp } = require('../src/time-utils');

test('buildTimestampPrefix formats a compact local timestamp tag with offset', () => {
  const date = new Date('2026-01-27T12:34:56.000Z');
  const prefix = buildTimestampPrefix({ date, timeZone: 'Europe/Madrid' });
  assert.equal(prefix, '[2026-01-27T13:34:56+01:00]');
});

test('prefixTextWithTimestamp adds prefix only for non-empty text', () => {
  const date = new Date('2026-01-27T12:34:56.000Z');
  assert.equal(prefixTextWithTimestamp('   ', { date, timeZone: 'Europe/Madrid' }), '   ');
  assert.equal(
    prefixTextWithTimestamp('  hello', { date, timeZone: 'Europe/Madrid' }),
    '[2026-01-27T13:34:56+01:00] hello'
  );
});

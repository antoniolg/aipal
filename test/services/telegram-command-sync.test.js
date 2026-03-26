const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BOT_COMMANDS,
  COMMAND_SCOPES,
  syncTelegramCommands,
} = require('../../src/services/telegram-command-sync');

test('syncTelegramCommands publishes commands for default, private, and group scopes', async () => {
  const calls = [];
  const logs = [];
  const bot = {
    telegram: {
      setMyCommands: async (commands, options) => {
        calls.push({ commands, options });
      },
    },
  };

  await syncTelegramCommands(bot, {
    info: (message) => {
      logs.push(message);
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((entry) => entry.commands),
    [BOT_COMMANDS, BOT_COMMANDS, BOT_COMMANDS]
  );
  assert.deepEqual(
    calls.map((entry) => entry.options),
    COMMAND_SCOPES.map((scope) => ({ scope }))
  );
  assert.equal(logs.length, 3);
  assert.match(logs[0], /default/);
  assert.match(logs[1], /all_private_chats/);
  assert.match(logs[2], /all_group_chats/);
});

test('syncTelegramCommands is a no-op when setMyCommands is unavailable', async () => {
  await syncTelegramCommands({}, console);
});

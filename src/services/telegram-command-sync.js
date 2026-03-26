const { BOT_COMMANDS } = require('../telegram-commands');

const COMMAND_SCOPES = [
  { type: 'default' },
  { type: 'all_private_chats' },
  { type: 'all_group_chats' },
];

async function syncTelegramCommands(bot, logger = console) {
  if (!bot?.telegram || typeof bot.telegram.setMyCommands !== 'function') {
    return;
  }

  for (const scope of COMMAND_SCOPES) {
    await bot.telegram.setMyCommands(BOT_COMMANDS, { scope });
    logger.info(
      `Synced ${BOT_COMMANDS.length} bot command(s) for Telegram scope=${scope.type}`
    );
  }
}

module.exports = {
  BOT_COMMANDS,
  COMMAND_SCOPES,
  syncTelegramCommands,
};

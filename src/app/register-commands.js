const { registerCronCommand } = require('../commands/cron');
const { registerHelpCommands } = require('../commands/help');
const { registerLaterCommand } = require('../commands/later');
const { registerMemoryCommand } = require('../commands/memory');
const { registerRunsCommand } = require('../commands/runs');
const { registerSettingsCommands } = require('../commands/settings');
const { registerStopCommand } = require('../commands/stop');

function registerCommands(options) {
  registerHelpCommands(options);
  registerSettingsCommands(options);
  registerStopCommand(options);
  registerCronCommand(options);
  registerLaterCommand(options);
  registerRunsCommand(options);
  registerMemoryCommand(options);
}

module.exports = {
  registerCommands,
};

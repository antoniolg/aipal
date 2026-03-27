const { registerCronCommand } = require('../commands/cron');
const { registerHelpCommands } = require('../commands/help');
const { registerLaterCommand } = require('../commands/later');
const { registerMemoryCommand } = require('../commands/memory');
const { registerResumeCommand } = require('../commands/resume');
const { registerRunsCommand } = require('../commands/runs');
const { registerSendToCodexCommand } = require('../commands/send-to-codex');
const { registerSettingsCommands } = require('../commands/settings');
const { registerStopCommand } = require('../commands/stop');

function registerCommands(options) {
  registerHelpCommands(options);
  registerSettingsCommands(options);
  registerResumeCommand(options);
  registerSendToCodexCommand(options);
  registerStopCommand(options);
  registerCronCommand(options);
  registerLaterCommand(options);
  registerRunsCommand(options);
  registerMemoryCommand(options);
}

module.exports = {
  registerCommands,
};

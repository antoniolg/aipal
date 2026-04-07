const BOT_COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'agent', description: 'Switch agent backend' },
  { command: 'thinking', description: 'Set reasoning effort' },
  { command: 'fast', description: 'Toggle codex-app fast/default tier' },
  { command: 'model', description: 'View or change the current model' },
  { command: 'resume', description: 'Resume a previous codex-app session' },
  { command: 'send_to_codex', description: 'Fork the current session into Codex App' },
  { command: 'status', description: 'Show current topic session status' },
  { command: 'stop', description: 'Interrupt the active run' },
  { command: 'memory', description: 'Inspect and curate memory' },
  { command: 'reset', description: 'Reset the current agent session' },
  { command: 'cron', description: 'Manage cron jobs' },
  { command: 'later', description: 'Schedule a one-shot future run' },
  { command: 'runs', description: 'Show recent cron executions' },
  { command: 'help', description: 'Show help and scripts' },
  {
    command: 'document_scripts',
    description: 'Generate script descriptions',
  },
];

function buildHelpCommandLines() {
  return [
    '/start - Hello world',
    '/agent <name> - Switch agent (codex, codex-app, claude, gemini, opencode)',
    '/thinking <level> - Set reasoning effort',
    '/fast - Toggle codex-app service tier between fast and default',
    '/model [model_id|reset] - View/set/reset model for current agent',
    '/resume [query] [--all] - List/search previous codex-app sessions for this topic',
    '/send_to_codex - Fork the current codex-app session into Codex App under a selected project',
    '/status - Show the current topic status and codex-app binding',
    '/stop - Interrupt the active run in this topic',
    '/memory [query|status|tail|search|curate] - Manual memory retrieval + curation',
    '/reset - Reset current agent session',
    '/cron [list|reload|chatid|assign|unassign|run|inspect] - Manage cron jobs',
    '/later <ISO> | <prompt> - Schedule a one-shot future run',
    '/runs [jobId] [n] - Show recent cron executions',
    '/help - Show this help',
    '/document_scripts confirm - Auto-document available scripts (requires ALLOWED_USERS)',
  ];
}

module.exports = {
  BOT_COMMANDS,
  buildHelpCommandLines,
};

function registerHelpCommands(options) {
  const {
    allowedUsers,
    bot,
    enqueue,
    extractCommandValue,
    markdownToTelegramHtml,
    replyWithError,
    runAgentOneShot,
    scriptManager,
    startTyping,
  } = options;

  bot.command('help', async (ctx) => {
    const builtIn = [
      '/start - Hello world',
      '/agent <name> - Switch agent (codex, claude, gemini, opencode)',
      '/thinking <level> - Set reasoning effort',
      '/model [model_id|reset] - View/set/reset model for current agent',
      '/project [path|reset] - Set project working directory',
      '/menu - Open interactive menu for projects and sessions',
      '/projects [n] - List local Codex projects and open one',
      '/sessions [limit] - List recent local Codex sessions',
      '/session <id> - Attach a local Codex session to this topic',
      '/memory [status|tail|search|curate] - Memory capture + retrieval + curation',
      '/reset - Reset current agent session',
      '/cron [list|reload|chatid|assign|unassign|run] - Manage cron jobs',
      '/help - Show this help',
      '/document_scripts confirm - Auto-document available scripts (requires ALLOWED_USERS)',
    ];

    let scripts = [];
    try {
      scripts = await scriptManager.listScripts();
    } catch (err) {
      console.error('Failed to list scripts', err);
      scripts = [];
    }

    const scriptLines = scripts.map((s) => {
      const llmTag = s.llm?.prompt ? ' [LLM]' : '';
      const desc = s.description ? ` - ${s.description}` : '';
      return `- /${s.name}${llmTag}${desc}`;
    });

    const messageMd = [
      '**Built-in commands:**',
      ...builtIn.map((line) => `- ${line}`),
      '',
      '**Scripts:**',
      ...(scriptLines.length ? scriptLines : ['(none)']),
    ].join('\n');

    const message = markdownToTelegramHtml(messageMd);
    ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  bot.command('document_scripts', async (ctx) => {
    const chatId = ctx.chat.id;
    if (allowedUsers.size === 0) {
      await ctx.reply(
        'ALLOWED_USERS is not configured. /document_scripts is disabled.'
      );
      return;
    }

    const value = extractCommandValue(ctx.message.text);
    const confirmed = value === 'confirm' || value === '--yes';
    if (!confirmed) {
      await ctx.reply(
        [
          'This will send the first 2000 chars of each script to the active agent',
          'to generate a short description and write it to `scripts.json`.',
          '',
          'Run `/document_scripts confirm` to proceed.',
        ].join('\n')
      );
      return;
    }

    await ctx.reply('Scanning for undocumented scripts...');

    enqueue(chatId, async () => {
      let scripts = [];
      try {
        scripts = await scriptManager.listScripts();
      } catch (err) {
        await replyWithError(ctx, 'Failed to list scripts', err);
        return;
      }

      const undocumented = scripts.filter((script) => !script.description);
      if (undocumented.length === 0) {
        await ctx.reply('All scripts are already documented!');
        return;
      }

      await ctx.reply(
        `Found ${undocumented.length} undocumented scripts. Processing...`
      );

      const stopTyping = startTyping(ctx);
      try {
        for (const script of undocumented) {
          try {
            const content = await scriptManager.getScriptContent(script.name);
            const prompt = [
              'Analyze the following script and provide a very short description (max 10 words).',
              'Return ONLY the description (no quotes, no extra text).',
              '',
              'Script:',
              content.slice(0, 2000),
            ].join('\n');

            const description = await runAgentOneShot(prompt);
            const cleaned = String(description || '')
              .split(/\r?\n/)[0]
              .trim()
              .replace(/^['"]|['"]$/g, '')
              .slice(0, 140);

            if (!cleaned) {
              await ctx.reply(`Skipped ${script.name}: empty description`);
              continue;
            }

            await scriptManager.updateScriptMetadata(script.name, {
              description: cleaned,
            });
            await ctx.reply(`Documented ${script.name}: ${cleaned}`);
          } catch (err) {
            console.error(`Failed to document ${script.name}`, err);
            await ctx.reply(`Failed to document ${script.name}: ${err.message}`);
          }
        }
      } finally {
        stopTyping();
      }

      await ctx.reply('Documentation complete. Use /help to see the results.');
    });
  });
}

module.exports = {
  registerHelpCommands,
};

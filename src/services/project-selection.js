const { randomUUID } = require('crypto');
const { buildTelegramThreadExtra } = require('./telegram-topics');

const PROJECT_CALLBACK_PREFIX = 'project_select';
const PROJECT_PAGE_CALLBACK_PREFIX = 'project_page';
const PAGE_SIZE = 10;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateMiddle(value, maxLength = 48) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) return text;
  const head = Math.max(8, Math.floor((maxLength - 1) / 2));
  const tail = Math.max(8, maxLength - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function formatProjectButton(project, currentProjectPath) {
  const label = String(project?.label || '').trim() || 'Proyecto';
  const prefix = String(project?.path || '') === String(currentProjectPath || '')
    ? '✓ '
    : project?.active
      ? '[ACTIVO] '
      : '';
  return `${prefix}${label}`;
}

function formatProjectPath(projectPath) {
  return truncateMiddle(projectPath, 70) || '(default)';
}

function formatPagedRange(total, page) {
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = Math.min(total, (page + 1) * PAGE_SIZE);
  return { end, start };
}

function buildMessageOptions(topicId, replyMarkup) {
  return {
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
    ...buildTelegramThreadExtra({
      forceTopic: true,
      topicId,
    }),
  };
}

function createProjectSelectionService(options) {
  const {
    bot,
    listProjects,
    logger = console,
    onSelectProject,
  } = options;

  const pendingPickers = new Map();
  const pendingSelections = new Map();

  function buildCallbackData(token) {
    return `${PROJECT_CALLBACK_PREFIX}:${token}`;
  }

  function buildPageCallbackData(pickerId, page) {
    return `${PROJECT_PAGE_CALLBACK_PREFIX}:${pickerId}:${page}`;
  }

  function registerSelectionTokens(entry) {
    const tokenById = new Map();
    for (const item of entry.items) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12);
      tokenById.set(item.id, token);
      pendingSelections.set(token, {
        chatId: entry.chatId,
        item,
        pickerId: entry.pickerId,
        topicId: entry.topicId,
      });
    }
    return tokenById;
  }

  function buildKeyboard(entry, tokenById, page) {
    const pageItems = entry.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const inlineKeyboard = pageItems.map((item) => [
      {
        text: formatProjectButton(item, entry.currentProjectPath),
        callback_data: buildCallbackData(tokenById.get(item.id)),
      },
    ]);
    const totalPages = Math.ceil(entry.items.length / PAGE_SIZE);
    if (totalPages > 1) {
      const navRow = [];
      if (page > 0) {
        navRow.push({
          text: 'Previous',
          callback_data: buildPageCallbackData(entry.pickerId, page - 1),
        });
      }
      if (page < totalPages - 1) {
        navRow.push({
          text: 'Next',
          callback_data: buildPageCallbackData(entry.pickerId, page + 1),
        });
      }
      if (navRow.length > 0) inlineKeyboard.push(navRow);
    }
    return { inline_keyboard: inlineKeyboard };
  }

  function buildProjectPickerText(entry, page) {
    const { end, start } = formatPagedRange(entry.items.length, page);
    const lines = [
      '<b>Project for this Telegram topic</b>',
      '',
      `Current: <code>${escapeHtml(formatProjectPath(entry.currentProjectPath))}</code>`,
      '',
      `Choose a project (${entry.items.length}):`,
    ];
    if (entry.items.length > PAGE_SIZE) {
      lines.push(`Showing ${start}-${end}.`);
    }
    return lines.join('\n');
  }

  async function sendProjectPicker(ctx, params = {}) {
    const projects = await listProjects();
    if (!Array.isArray(projects) || projects.length === 0) {
      await ctx.reply('No saved Codex App projects were found.');
      return;
    }

    const pickerId = randomUUID().replace(/-/g, '').slice(0, 12);
    const topicId = ctx.message?.message_thread_id;
    const items = projects.map((project) => ({
      active: Boolean(project.active),
      id: project.path,
      label: project.label,
      path: project.path,
    }));
    const entry = {
      chatId: ctx.chat.id,
      currentProjectPath: params.currentProjectPath || '',
      items,
      pickerId,
      topicId,
    };
    pendingPickers.set(pickerId, entry);
    const tokenById = registerSelectionTokens(entry);
    const page = 0;
    return bot.telegram.sendMessage(
      ctx.chat.id,
      buildProjectPickerText(entry, page),
      buildMessageOptions(topicId, buildKeyboard(entry, tokenById, page))
    );
  }

  async function handleCallbackQuery(ctx) {
    const data = String(ctx.callbackQuery?.data || '');
    const pageMatch = data.match(new RegExp(`^${PROJECT_PAGE_CALLBACK_PREFIX}:([^:]+):(\\d+)$`));
    if (pageMatch) {
      const [, pickerId, pageText] = pageMatch;
      const entry = pendingPickers.get(pickerId);
      if (!entry) {
        await ctx.answerCbQuery('This picker is no longer active.');
        return true;
      }
      const page = Number.parseInt(pageText, 10);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCbQuery('Invalid page.');
        return true;
      }
      const tokenById = registerSelectionTokens(entry);
      await ctx.editMessageText(
        buildProjectPickerText(entry, page),
        buildMessageOptions(entry.topicId, buildKeyboard(entry, tokenById, page))
      );
      await ctx.answerCbQuery('');
      return true;
    }

    const projectMatch = data.match(new RegExp(`^${PROJECT_CALLBACK_PREFIX}:([^:]+)$`));
    if (!projectMatch) return false;
    const selection = pendingSelections.get(projectMatch[1]);
    if (!selection) {
      await ctx.answerCbQuery('This selection is no longer active.');
      return true;
    }

    try {
      const result = await onSelectProject({
        chatId: selection.chatId,
        project: selection.item,
        topicId: selection.topicId,
      });
      await ctx.editMessageText(
        [
          '<b>Project set for this topic</b>',
          '',
          `<b>Project:</b> ${escapeHtml(result.projectLabel || selection.item.label || 'Proyecto')}`,
          `<b>Path:</b> <code>${escapeHtml(result.projectPath)}</code>`,
          '',
          'The next codex-app message in this topic will start in this project.',
        ].join('\n'),
        {
          disable_web_page_preview: true,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        }
      );
      await ctx.answerCbQuery('Project set.');
    } catch (err) {
      logger.warn('Failed to set project for topic:', err);
      await ctx.answerCbQuery('Failed to set the project.', { show_alert: true });
    }
    return true;
  }

  function shutdown() {
    pendingPickers.clear();
    pendingSelections.clear();
  }

  return {
    handleCallbackQuery,
    sendProjectPicker,
    shutdown,
  };
}

module.exports = {
  createProjectSelectionService,
  formatProjectPath,
};

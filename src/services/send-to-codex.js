const { randomUUID } = require('crypto');
const { buildTelegramThreadExtra } = require('./telegram-topics');

const PROJECT_CALLBACK_PREFIX = 'send_to_codex_project';
const PROJECT_PAGE_CALLBACK_PREFIX = 'send_to_codex_project_page';
const PAGE_SIZE = 10;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateMiddle(value, maxLength = 40) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) return text;
  const head = Math.max(8, Math.floor((maxLength - 1) / 2));
  const tail = Math.max(8, maxLength - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function formatProjectButton(project) {
  const label = String(project?.label || '').trim() || 'Proyecto';
  const prefix = project?.active ? '[ACTIVO] ' : '';
  return `${prefix}${label}`;
}

function formatPagedRange(total, page) {
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = Math.min(total, (page + 1) * PAGE_SIZE);
  return { end, start };
}

function getProjectName(projectPath) {
  return truncateMiddle(String(projectPath || '').split('/').filter(Boolean).pop(), 40) || 'Unnamed project';
}

function createSendToCodexService(options) {
  const {
    bot,
    listProjects,
    logger = console,
    onSendToCodex,
  } = options;

  const pendingProjectPickers = new Map();
  const pendingProjectSelections = new Map();

  function buildCallbackData(prefix, token) {
    return `${prefix}:${token}`;
  }

  function buildPageCallbackData(prefix, pickerId, page) {
    return `${prefix}:${pickerId}:${page}`;
  }

  function buildPagedKeyboard({
    buttonFormatter,
    itemCallbackPrefix,
    items,
    page,
    pageCallbackPrefix,
    pickerId,
    tokenById,
  }) {
    const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const inlineKeyboard = pageItems.map((item) => [
      {
        text: buttonFormatter(item),
        callback_data: buildCallbackData(itemCallbackPrefix, tokenById.get(item.id)),
      },
    ]);
    const totalPages = Math.ceil(items.length / PAGE_SIZE);
    if (totalPages > 1) {
      const navRow = [];
      if (page > 0) {
        navRow.push({
          text: 'Previous',
          callback_data: buildPageCallbackData(pageCallbackPrefix, pickerId, page - 1),
        });
      }
      if (page < totalPages - 1) {
        navRow.push({
          text: 'Next',
          callback_data: buildPageCallbackData(pageCallbackPrefix, pickerId, page + 1),
        });
      }
      if (navRow.length > 0) inlineKeyboard.push(navRow);
    }
    return { inline_keyboard: inlineKeyboard };
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

  function buildProjectPickerText(entry, page) {
    const { end, start } = formatPagedRange(entry.items.length, page);
    const lines = [
      '<b>Send session to Codex App</b>',
    ];
    if (entry.sourceThread.title) {
      lines.push('');
      lines.push(`Title: ${escapeHtml(entry.sourceThread.title)}`);
    }
    lines.push('', `Choose a destination project (${entry.items.length}):`);
    if (entry.items.length > PAGE_SIZE) {
      lines.push(`Showing ${start}-${end}.`);
    }
    return lines.join('\n');
  }

  function registerSelectionTokens({
    chatId,
    itemMap,
    pickerId,
    selectionStore,
    topicId,
  }) {
    const tokenById = new Map();
    for (const item of itemMap.values()) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12);
      tokenById.set(item.id, token);
      selectionStore.set(token, {
        chatId,
        item,
        pickerId,
        topicId,
      });
    }
    return tokenById;
  }

  async function sendProjectPicker(ctx, sourceThread) {
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
      items,
      pickerId,
      sourceThread,
      topicId,
    };
    pendingProjectPickers.set(pickerId, entry);
    const tokenById = registerSelectionTokens({
      chatId: ctx.chat.id,
      itemMap: new Map(items.map((item) => [item.id, item])),
      pickerId,
      selectionStore: pendingProjectSelections,
      topicId,
    });
    for (const token of tokenById.values()) {
      const selection = pendingProjectSelections.get(token);
      if (selection) {
        selection.sourceThread = sourceThread;
      }
    }
    const page = 0;
    const replyMarkup = buildPagedKeyboard({
      buttonFormatter: formatProjectButton,
      itemCallbackPrefix: PROJECT_CALLBACK_PREFIX,
      items,
      page,
      pageCallbackPrefix: PROJECT_PAGE_CALLBACK_PREFIX,
      pickerId,
      tokenById,
    });
    return bot.telegram.sendMessage(
      ctx.chat.id,
      buildProjectPickerText(entry, page),
      buildMessageOptions(topicId, replyMarkup)
    );
  }

  async function handlePageCallback({
    answerText,
    callbackPrefix,
    ctx,
    messageBuilder,
    pickerStore,
    selectionStore,
    tokenPrefix,
    formatter,
  }) {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(new RegExp(`^${callbackPrefix}:([^:]+):(\\d+)$`));
    if (!match) return false;
    const [, pickerId, pageText] = match;
    const entry = pickerStore.get(pickerId);
    if (!entry) {
      await ctx.answerCbQuery('This picker is no longer active.');
      return true;
    }
    const page = Number.parseInt(pageText, 10);
    if (!Number.isInteger(page) || page < 0) {
      await ctx.answerCbQuery('Invalid page.');
      return true;
    }
    const tokenById = registerSelectionTokens({
      chatId: entry.chatId,
      itemMap: new Map(entry.items.map((item) => [item.id, item])),
      pickerId,
      selectionStore,
      topicId: entry.topicId,
    });
    const replyMarkup = buildPagedKeyboard({
      buttonFormatter: formatter,
      itemCallbackPrefix: tokenPrefix,
      items: entry.items,
      page,
      pageCallbackPrefix: callbackPrefix,
      pickerId,
      tokenById,
    });
    await ctx.editMessageText(
      messageBuilder(entry, page),
      buildMessageOptions(entry.topicId, replyMarkup)
    );
    await ctx.answerCbQuery(answerText);
    return true;
  }

  async function handleCallbackQuery(ctx) {
    const projectPageHandled = await handlePageCallback({
      answerText: '',
      callbackPrefix: PROJECT_PAGE_CALLBACK_PREFIX,
      ctx,
      formatter: formatProjectButton,
      messageBuilder: buildProjectPickerText,
      pickerStore: pendingProjectPickers,
      selectionStore: pendingProjectSelections,
      tokenPrefix: PROJECT_CALLBACK_PREFIX,
    });
    if (projectPageHandled) return true;

    const sessionData = String(ctx.callbackQuery?.data || '');
    const projectMatch = sessionData.match(new RegExp(`^${PROJECT_CALLBACK_PREFIX}:([^:]+)$`));
    if (!projectMatch) return false;
    const selection = pendingProjectSelections.get(projectMatch[1]);
    if (!selection) {
      await ctx.answerCbQuery('This selection is no longer active.');
      return true;
    }
    if (!selection.sourceThread?.threadId) {
      await ctx.answerCbQuery('This export is no longer active.', {
        show_alert: true,
      });
      return true;
    }

    try {
      const result = await onSendToCodex({
        chatId: selection.chatId,
        project: selection.item,
        sourceThread: selection.sourceThread,
        topicId: selection.topicId,
      });
      await ctx.editMessageText(
        [
          '<b>Session sent to Codex App</b>',
          '',
          `<b>Source thread:</b> <code>${escapeHtml(result.sourceThreadId)}</code>`,
          `<b>Forked thread:</b> <code>${escapeHtml(result.forkedThreadId)}</code>`,
          `<b>Project:</b> ${escapeHtml(result.projectLabel || getProjectName(result.projectPath))}`,
        ].join('\n'),
        {
          disable_web_page_preview: true,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        }
      );
      await ctx.answerCbQuery('Session sent.');
    } catch (err) {
      logger.warn('Failed to send session to Codex App:', err);
      await ctx.answerCbQuery('Failed to send the session to Codex App.', {
        show_alert: true,
      });
    }
    return true;
  }

  function shutdown() {
    pendingProjectPickers.clear();
    pendingProjectSelections.clear();
  }

  return {
    handleCallbackQuery,
    sendProjectPicker,
    shutdown,
  };
}

module.exports = {
  createSendToCodexService,
};

const { randomUUID } = require('crypto');
const {
  buildTelegramThreadExtra,
} = require('./telegram-topics');

const CALLBACK_PREFIX = 'resume_thread';
const PAGE_CALLBACK_PREFIX = 'resume_page';
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

function shortThreadId(threadId) {
  const text = String(threadId || '').trim();
  if (!text) return '';
  return text.length <= 12 ? text : text.slice(-12);
}

function formatThreadButton(thread) {
  const title = String(thread?.title || '').trim() || 'Untitled session';
  const cwd = truncateMiddle(thread?.cwd || '', 28);
  const threadId = shortThreadId(thread?.threadId || '');
  const sourceKind = String(thread?.sourceKind || '').trim().toLowerCase();
  const sourcePrefix =
    sourceKind && sourceKind !== 'custom'
      ? `[${sourceKind.toUpperCase()}] `
      : '';
  const parts = [`${sourcePrefix}${title}`];
  if (cwd) parts.push(cwd);
  if (threadId) parts.push(`#${threadId}`);
  return parts.join(' · ');
}

function formatThreadListMessage({
  currentBinding,
  effectiveAgentLabel,
  page,
  query,
  threads,
}) {
  const heading = query
    ? `<b>Matching codex-app sessions</b>\nQuery: <code>${escapeHtml(query)}</code>`
    : '<b>Recent codex-app sessions</b>';
  const lines = [heading];
  if (effectiveAgentLabel && effectiveAgentLabel !== 'codex-app') {
    lines.push(
      '',
      `Active agent in this topic: <b>${escapeHtml(effectiveAgentLabel)}</b>`,
      'The selection you make will be saved for <b>codex-app</b>.'
    );
  }
  if (currentBinding) {
    lines.push('', `Current codex-app binding: <code>${escapeHtml(currentBinding)}</code>`);
  }
  const total = threads.length;
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = Math.min(total, (page + 1) * PAGE_SIZE);
  lines.push('', `Choose a session (${total}):`);
  if (total > PAGE_SIZE) {
    lines.push(`Showing ${start}-${end}.`);
  }
  return lines.join('\n');
}

function createResumeThreadsService(options) {
  const {
    bot,
    logger = console,
    onSelectThread,
  } = options;
  const pendingSelections = new Map();
  const pendingPickers = new Map();

  function buildCallbackData(token) {
    return `${CALLBACK_PREFIX}:${token}`;
  }

  function buildPageCallbackData(pickerId, page) {
    return `${PAGE_CALLBACK_PREFIX}:${pickerId}:${page}`;
  }

  function buildKeyboard(threads, tokenByThreadId, pickerId, page) {
    const pageThreads = threads.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const inlineKeyboard = pageThreads.map((thread) => [
      {
        text: formatThreadButton(thread),
        callback_data: buildCallbackData(tokenByThreadId.get(thread.threadId)),
      },
    ]);
    const totalPages = Math.ceil(threads.length / PAGE_SIZE);
    if (totalPages > 1) {
      const navRow = [];
      if (page > 0) {
        navRow.push({
          text: 'Previous',
          callback_data: buildPageCallbackData(pickerId, page - 1),
        });
      }
      if (page < totalPages - 1) {
        navRow.push({
          text: 'Next',
          callback_data: buildPageCallbackData(pickerId, page + 1),
        });
      }
      if (navRow.length > 0) {
        inlineKeyboard.push(navRow);
      }
    }
    return {
      inline_keyboard: inlineKeyboard,
    };
  }

  function registerSelectionTokens(ctx, threads, pickerId) {
    const tokenByThreadId = new Map();
    for (const thread of threads) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12);
      tokenByThreadId.set(thread.threadId, token);
      pendingSelections.set(token, {
        chatId: ctx.chat.id,
        pickerId,
        thread: {
          cwd: thread.cwd,
          threadId: thread.threadId,
          title: thread.title,
        },
        topicId: ctx.message?.message_thread_id,
      });
    }
    return tokenByThreadId;
  }

  function buildPickerPayload(entry, tokenByThreadId, page) {
    return {
      disable_web_page_preview: true,
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(entry.threads, tokenByThreadId, entry.pickerId, page),
      ...buildTelegramThreadExtra({
        forceTopic: true,
        topicId: entry.topicId,
      }),
      text: formatThreadListMessage({
        currentBinding: entry.currentBinding,
        effectiveAgentLabel: entry.effectiveAgentLabel,
        page,
        query: entry.query,
        threads: entry.threads,
      }),
    };
  }

  async function sendThreadPicker(ctx, params) {
    const {
      currentBinding,
      effectiveAgentLabel,
      query,
      threads,
    } = params;
    const pickerId = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = {
      chatId: ctx.chat.id,
      currentBinding,
      effectiveAgentLabel,
      pickerId,
      query,
      threads,
      topicId: ctx.message?.message_thread_id,
    };
    pendingPickers.set(pickerId, entry);
    const tokenByThreadId = registerSelectionTokens(ctx, threads, pickerId);
    const payload = buildPickerPayload(entry, tokenByThreadId, 0);
    return bot.telegram.sendMessage(
      ctx.chat.id,
      payload.text,
      payload
    );
  }

  async function handleCallbackQuery(ctx) {
    const data = String(ctx.callbackQuery?.data || '');
    const pageMatch = data.match(/^resume_page:([^:]+):(\d+)$/);
    if (pageMatch) {
      const [, pickerId, pageText] = pageMatch;
      const entry = pendingPickers.get(pickerId);
      if (!entry) {
        await ctx.answerCbQuery('This picker is no longer active.', {
          show_alert: false,
        });
        return true;
      }

      const page = Number.parseInt(pageText, 10);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCbQuery('Invalid page.', {
          show_alert: false,
        });
        return true;
      }

      const tokenByThreadId = registerSelectionTokens(
        {
          chat: { id: entry.chatId },
          message: { message_thread_id: entry.topicId },
        },
        entry.threads,
        pickerId
      );
      const payload = buildPickerPayload(entry, tokenByThreadId, page);
      await ctx.editMessageText(payload.text, {
        disable_web_page_preview: payload.disable_web_page_preview,
        parse_mode: payload.parse_mode,
        reply_markup: payload.reply_markup,
      });
      await ctx.answerCbQuery();
      return true;
    }

    const match = data.match(/^resume_thread:([^:]+)$/);
    if (!match) return false;

    const [, token] = match;
    const entry = pendingSelections.get(token);
    if (!entry) {
      await ctx.answerCbQuery('This selection is no longer active.', {
        show_alert: false,
      });
      return true;
    }

    pendingSelections.delete(token);
    try {
      await Promise.resolve(onSelectThread(entry, ctx));
      const label = String(entry.thread.title || shortThreadId(entry.thread.threadId));
      await ctx.answerCbQuery(`Session resumed: ${label}`);
    } catch (err) {
      logger.warn('Failed to handle resume selection:', err);
      await ctx.answerCbQuery('Failed to resume that session.', {
        show_alert: true,
      });
    }
    return true;
  }

  function shutdown() {
    pendingSelections.clear();
    pendingPickers.clear();
  }

  return {
    handleCallbackQuery,
    sendThreadPicker,
    shutdown,
  };
}

module.exports = {
  CALLBACK_PREFIX,
  PAGE_CALLBACK_PREFIX,
  createResumeThreadsService,
  formatThreadButton,
};

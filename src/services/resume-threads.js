const { randomUUID } = require('crypto');
const {
  buildTelegramThreadExtra,
} = require('./telegram-topics');

const CALLBACK_PREFIX = 'resume_thread';

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
  const title = String(thread?.title || '').trim() || 'Sesion sin titulo';
  const cwd = truncateMiddle(thread?.cwd || '', 28);
  const threadId = shortThreadId(thread?.threadId || '');
  const parts = [title];
  if (cwd) parts.push(cwd);
  if (threadId) parts.push(`#${threadId}`);
  return parts.join(' · ');
}

function formatThreadListMessage({
  currentBinding,
  effectiveAgentLabel,
  query,
  threads,
}) {
  const heading = query
    ? `<b>Sesiones encontradas para codex-app</b>\nBusqueda: <code>${escapeHtml(query)}</code>`
    : '<b>Sesiones recientes de codex-app</b>';
  const lines = [heading];
  if (effectiveAgentLabel && effectiveAgentLabel !== 'codex-app') {
    lines.push(
      '',
      `Agente activo en este topic: <b>${escapeHtml(effectiveAgentLabel)}</b>`,
      'El binding que elijas se guardara para <b>codex-app</b>.'
    );
  }
  if (currentBinding) {
    lines.push('', `Binding actual de codex-app: <code>${escapeHtml(currentBinding)}</code>`);
  }
  lines.push('', `Elige una sesion (${threads.length}):`);
  return lines.join('\n');
}

function createResumeThreadsService(options) {
  const {
    bot,
    logger = console,
    onSelectThread,
  } = options;
  const pendingSelections = new Map();

  function buildCallbackData(token) {
    return `${CALLBACK_PREFIX}:${token}`;
  }

  function buildKeyboard(threads, tokenByThreadId) {
    return {
      inline_keyboard: threads.map((thread) => [
        {
          text: formatThreadButton(thread),
          callback_data: buildCallbackData(tokenByThreadId.get(thread.threadId)),
        },
      ]),
    };
  }

  async function sendThreadPicker(ctx, params) {
    const {
      currentBinding,
      effectiveAgentLabel,
      query,
      threads,
    } = params;
    const tokenByThreadId = new Map();
    for (const thread of threads) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12);
      tokenByThreadId.set(thread.threadId, token);
      pendingSelections.set(token, {
        chatId: ctx.chat.id,
        thread: {
          cwd: thread.cwd,
          threadId: thread.threadId,
          title: thread.title,
        },
        topicId: ctx.message?.message_thread_id,
      });
    }
    return bot.telegram.sendMessage(
      ctx.chat.id,
      formatThreadListMessage({
        currentBinding,
        effectiveAgentLabel,
        query,
        threads,
      }),
      {
        disable_web_page_preview: true,
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(threads, tokenByThreadId),
        ...buildTelegramThreadExtra({
          forceTopic: true,
          topicId: ctx.message?.message_thread_id,
        }),
      }
    );
  }

  async function handleCallbackQuery(ctx) {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(/^resume_thread:([^:]+)$/);
    if (!match) return false;

    const [, token] = match;
    const entry = pendingSelections.get(token);
    if (!entry) {
      await ctx.answerCbQuery('Esta seleccion ya no esta activa.', {
        show_alert: false,
      });
      return true;
    }

    pendingSelections.delete(token);
    try {
      await Promise.resolve(onSelectThread(entry, ctx));
      const label = String(entry.thread.title || shortThreadId(entry.thread.threadId));
      await ctx.answerCbQuery(`Sesion reanudada: ${label}`);
    } catch (err) {
      logger.warn('Failed to handle resume selection:', err);
      await ctx.answerCbQuery('No se pudo reanudar esa sesion.', {
        show_alert: true,
      });
    }
    return true;
  }

  function shutdown() {
    pendingSelections.clear();
  }

  return {
    handleCallbackQuery,
    sendThreadPicker,
    shutdown,
  };
}

module.exports = {
  CALLBACK_PREFIX,
  createResumeThreadsService,
  formatThreadButton,
};

const { randomUUID } = require('crypto');
const {
  buildTelegramThreadExtra,
} = require('./telegram-topics');

const CALLBACK_PREFIX = 'elicitation';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createElicitationService(options) {
  const { bot, logger = console } = options;
  const pendingByToken = new Map();
  const pendingByRequest = new Map();

  function buildRequestKey(threadId, requestId) {
    return `${String(threadId)}:${String(requestId)}`;
  }

  function buildCallbackData(token, action) {
    return `${CALLBACK_PREFIX}:${token}:${action}`;
  }

  function hasFormFields(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return false;
    }
    const properties =
      schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties
        : {};
    return Object.keys(properties).length > 0;
  }

  function canAcceptDirectly(request) {
    if (request.mode === 'url') return true;
    if (request.mode !== 'form') return false;
    return !hasFormFields(request.requestedSchema);
  }

  function formatSchemaSummary(schema) {
    if (!hasFormFields(schema)) return '';
    const fields = Object.keys(schema.properties).slice(0, 6);
    if (fields.length === 0) return '';
    return fields.map((field) => `• <code>${escapeHtml(field)}</code>`).join('\n');
  }

  function formatElicitationText(request) {
    const lines = ['<b>Accion requerida del conector</b>'];
    if (request.serverName) {
      lines.push('', `<b>Servidor:</b> ${escapeHtml(request.serverName)}`);
    }
    if (request.message) {
      lines.push(`<b>Mensaje:</b> ${escapeHtml(request.message)}`);
    }
    if (request.mode === 'url' && request.url) {
      lines.push(`<b>URL:</b> ${escapeHtml(request.url)}`);
    }
    if (request.mode === 'form') {
      const summary = formatSchemaSummary(request.requestedSchema);
      if (summary) {
        lines.push('', '<b>Campos solicitados:</b>', summary);
        lines.push('', 'Aipal todavia no soporta responder este formulario desde Telegram.');
      }
    }
    return lines.join('\n');
  }

  function buildInlineKeyboard(entry) {
    const rows = [];
    if (entry.request.mode === 'url' && entry.request.url) {
      rows.push([{ text: 'Abrir enlace', url: entry.request.url }]);
    }
    const actions = [];
    if (entry.canAcceptDirectly) {
      actions.push({ text: 'Aceptar', callback_data: buildCallbackData(entry.token, 'accept') });
    }
    actions.push({ text: 'Rechazar', callback_data: buildCallbackData(entry.token, 'decline') });
    actions.push({ text: 'Cancelar', callback_data: buildCallbackData(entry.token, 'cancel') });
    rows.push(actions);
    return { inline_keyboard: rows };
  }

  async function editElicitationMessage(entry, text) {
    if (!entry.messageId) return;
    try {
      await bot.telegram.editMessageText(
        entry.chatId,
        entry.messageId,
        undefined,
        text,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        }
      );
    } catch (err) {
      const message = String(err?.message || err || '');
      if (message.includes('message is not modified')) {
        return;
      }
      logger.warn('Failed to update elicitation message:', err);
    }
  }

  function formatResolvedText(entry, action) {
    const labels = {
      accept: 'aceptada',
      cancel: 'cancelada',
      decline: 'rechazada',
    };
    return `${formatElicitationText(entry.request)}\n\n<b>Estado:</b> ${escapeHtml(labels[action] || action)}`;
  }

  function settleEntry(entry, response) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    pendingByToken.delete(entry.token);
    pendingByRequest.delete(buildRequestKey(entry.threadId, entry.requestId));
    entry.resolveResponse(response);
    void editElicitationMessage(entry, formatResolvedText(entry, response.action));
  }

  async function requestElicitation(request, context = {}) {
    const threadExtra = buildTelegramThreadExtra({
      forceTopic: true,
      topicId: context.topicId,
    });
    const token = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = {
      canAcceptDirectly: canAcceptDirectly(request),
      chatId: context.chatId,
      messageId: null,
      request,
      requestId: request.requestId,
      resolveResponse: null,
      settled: false,
      threadId: request.threadId,
      token,
      topicId: context.topicId,
    };
    const responsePromise = new Promise((resolve) => {
      entry.resolveResponse = resolve;
    });
    pendingByToken.set(token, entry);
    pendingByRequest.set(buildRequestKey(entry.threadId, entry.requestId), entry);

    try {
      const message = await bot.telegram.sendMessage(
        context.chatId,
        formatElicitationText(request),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: buildInlineKeyboard(entry),
          ...threadExtra,
        }
      );
      entry.messageId = message?.message_id || null;
    } catch (err) {
      pendingByToken.delete(token);
      pendingByRequest.delete(buildRequestKey(entry.threadId, entry.requestId));
      logger.warn('Failed to send elicitation message:', err);
      return { action: 'cancel', content: null };
    }

    return responsePromise;
  }

  function resolveServerRequest({ requestId, threadId }) {
    const entry = pendingByRequest.get(buildRequestKey(threadId, requestId));
    if (!entry) return;
    settleEntry(entry, { action: 'cancel', content: null });
  }

  async function handleCallbackQuery(ctx) {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(/^elicitation:([^:]+):([^:]+)$/);
    if (!match) return false;

    const [, token, action] = match;
    const entry = pendingByToken.get(token);
    if (!entry || entry.settled) {
      await ctx.answerCbQuery('Esta accion ya no esta activa.', {
        show_alert: false,
      });
      return true;
    }

    if (action === 'accept' && !entry.canAcceptDirectly) {
      await ctx.answerCbQuery('Este formulario todavia no se puede responder desde Telegram.', {
        show_alert: false,
      });
      return true;
    }

    const normalizedAction =
      action === 'accept' || action === 'decline' || action === 'cancel'
        ? action
        : 'cancel';
    settleEntry(entry, {
      action: normalizedAction,
      content: null,
    });
    const labels = {
      accept: 'aceptada',
      cancel: 'cancelada',
      decline: 'rechazada',
    };
    await ctx.answerCbQuery(`Accion: ${labels[normalizedAction] || normalizedAction}`);
    return true;
  }

  function shutdown() {
    for (const entry of pendingByToken.values()) {
      settleEntry(entry, { action: 'cancel', content: null });
    }
    pendingByToken.clear();
    pendingByRequest.clear();
  }

  return {
    handleCallbackQuery,
    requestElicitation,
    resolveServerRequest,
    shutdown,
  };
}

module.exports = {
  CALLBACK_PREFIX,
  createElicitationService,
};

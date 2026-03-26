const { randomUUID } = require('crypto');
const {
  buildTelegramThreadExtra,
} = require('./telegram-topics');

const CALLBACK_PREFIX = 'approval';
const MAX_LISTED_PATHS = 6;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createApprovalService(options) {
  const { bot, logger = console } = options;
  const pendingByToken = new Map();
  const pendingByRequest = new Map();

  function buildRequestKey(threadId, requestId) {
    return `${String(threadId)}:${String(requestId)}`;
  }

  function mapDecision(action) {
    if (action === 'accept') return 'accept';
    if (action === 'accept_session') return 'acceptForSession';
    if (action === 'decline') return 'decline';
    return 'cancel';
  }

  function buildCallbackData(token, action) {
    return `${CALLBACK_PREFIX}:${token}:${action}`;
  }

  function buildInlineKeyboard(token) {
    return {
      inline_keyboard: [
        [
          { text: 'Aprobar', callback_data: buildCallbackData(token, 'accept') },
          {
            text: 'Aprobar sesion',
            callback_data: buildCallbackData(token, 'accept_session'),
          },
        ],
        [
          { text: 'Rechazar', callback_data: buildCallbackData(token, 'decline') },
          { text: 'Cancelar', callback_data: buildCallbackData(token, 'cancel') },
        ],
      ],
    };
  }

  function truncateText(value, maxLength = 400) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
  }

  function formatCommandApprovalText(request) {
    const lines = ['<b>Approval solicitada</b>', '', '<b>Tipo:</b> comando'];
    if (request.reason) {
      lines.push(`<b>Motivo:</b> ${escapeHtml(request.reason)}`);
    }
    if (request.command) {
      lines.push(`<b>Comando:</b> <code>${escapeHtml(request.command)}</code>`);
    }
    if (request.cwd) {
      lines.push(`<b>CWD:</b> <code>${escapeHtml(request.cwd)}</code>`);
    }
    const network = request.networkApprovalContext || null;
    if (network?.host || network?.protocol) {
      const description = [network.protocol, network.host, network.port]
        .filter(Boolean)
        .join(' ');
      lines.push(`<b>Network:</b> ${escapeHtml(description)}`);
    }
    if (Array.isArray(request.commandActions) && request.commandActions.length > 0) {
      const actions = request.commandActions
        .slice(0, MAX_LISTED_PATHS)
        .map((action) => {
          const label = action.description || action.action || JSON.stringify(action);
          return `• ${escapeHtml(truncateText(label, 120))}`;
        });
      lines.push('', '<b>Acciones detectadas:</b>', ...actions);
    }
    return lines.join('\n');
  }

  function formatFileChangeApprovalText(request) {
    const lines = ['<b>Approval solicitada</b>', '', '<b>Tipo:</b> cambios de archivos'];
    if (request.reason) {
      lines.push(`<b>Motivo:</b> ${escapeHtml(request.reason)}`);
    }
    if (request.grantRoot) {
      lines.push(`<b>Grant root:</b> <code>${escapeHtml(request.grantRoot)}</code>`);
    }
    const changes = Array.isArray(request.item?.changes) ? request.item.changes : [];
    if (changes.length > 0) {
      const visible = changes.slice(0, MAX_LISTED_PATHS);
      lines.push('', `<b>Archivos:</b> ${changes.length}`);
      for (const change of visible) {
        lines.push(`• <code>${escapeHtml(change.path || '(sin path)')}</code>`);
      }
      if (changes.length > visible.length) {
        lines.push(`• …y ${changes.length - visible.length} mas`);
      }
    }
    return lines.join('\n');
  }

  function formatApprovalText(request) {
    if (request.kind === 'file_change') {
      return formatFileChangeApprovalText(request);
    }
    return formatCommandApprovalText(request);
  }

  function formatResolvedText(entry, label) {
    return `${formatApprovalText(entry.request)}\n\n<b>Estado:</b> ${escapeHtml(label)}`;
  }

  async function editApprovalMessage(entry, text) {
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
      logger.warn('Failed to update approval message:', err);
    }
  }

  function settleEntry(entry, decision, label) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    pendingByToken.delete(entry.token);
    pendingByRequest.delete(buildRequestKey(entry.threadId, entry.requestId));
    entry.resolveDecision(decision);
    void editApprovalMessage(entry, formatResolvedText(entry, label));
  }

  async function requestApproval(request, context = {}) {
    const threadExtra = buildTelegramThreadExtra({
      forceTopic: true,
      topicId: context.topicId,
    });
    const token = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = {
      chatId: context.chatId,
      messageId: null,
      request,
      requestId: request.requestId,
      resolveDecision: null,
      settled: false,
      threadId: request.threadId,
      token,
      topicId: context.topicId,
    };
    const decisionPromise = new Promise((resolve) => {
      entry.resolveDecision = resolve;
    });
    pendingByToken.set(token, entry);
    pendingByRequest.set(buildRequestKey(entry.threadId, entry.requestId), entry);

    try {
      const message = await bot.telegram.sendMessage(
        context.chatId,
        formatApprovalText(request),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: buildInlineKeyboard(token),
          ...threadExtra,
        }
      );
      entry.messageId = message?.message_id || null;
    } catch (err) {
      pendingByToken.delete(token);
      pendingByRequest.delete(buildRequestKey(entry.threadId, entry.requestId));
      logger.warn('Failed to send approval message:', err);
      return 'cancel';
    }

    return decisionPromise;
  }

  function resolveServerRequest({ requestId, threadId }) {
    const entry = pendingByRequest.get(buildRequestKey(threadId, requestId));
    if (!entry) return;
    settleEntry(entry, null, 'resuelta');
  }

  async function handleCallbackQuery(ctx) {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(/^approval:([^:]+):([^:]+)$/);
    if (!match) return false;

    const [, token, action] = match;
    const entry = pendingByToken.get(token);
    if (!entry || entry.settled) {
      await ctx.answerCbQuery('Esta approval ya no esta activa.', {
        show_alert: false,
      });
      return true;
    }

    const decision = mapDecision(action);
    const labelMap = {
      accept: 'aprobada',
      acceptForSession: 'aprobada para la sesion',
      cancel: 'cancelada',
      decline: 'rechazada',
    };
    settleEntry(entry, decision, labelMap[decision] || 'resuelta');
    await ctx.answerCbQuery(`Decision: ${labelMap[decision] || decision}`);
    return true;
  }

  function shutdown() {
    for (const entry of pendingByToken.values()) {
      settleEntry(entry, null, 'expirada');
    }
    pendingByToken.clear();
    pendingByRequest.clear();
  }

  return {
    handleCallbackQuery,
    requestApproval,
    resolveServerRequest,
    shutdown,
  };
}

module.exports = {
  CALLBACK_PREFIX,
  createApprovalService,
};

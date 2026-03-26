const { registerApprovalCallbacks } = require('../handlers/approval-callbacks');
const { registerMediaHandlers } = require('../handlers/media');
const { registerTextHandler } = require('../handlers/text');

function registerHandlers(options) {
  registerApprovalCallbacks(options);
  registerTextHandler(options);
  registerMediaHandlers(options);
}

module.exports = {
  registerHandlers,
};

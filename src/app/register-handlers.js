const { registerMediaHandlers } = require('../handlers/media');
const { registerTextHandler } = require('../handlers/text');

function registerHandlers(options) {
  registerTextHandler(options);
  registerMediaHandlers(options);
}

module.exports = {
  registerHandlers,
};

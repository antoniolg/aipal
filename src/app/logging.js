function formatLogTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function installLogTimestamps() {
  const levels = ['log', 'info', 'warn', 'error'];
  const original = {};
  for (const level of levels) {
    original[level] = console[level].bind(console);
  }
  for (const level of levels) {
    console[level] = (...args) => {
      original[level](`[${formatLogTimestamp()}]`, ...args);
    };
  }
}

module.exports = {
  formatLogTimestamp,
  installLogTimestamps,
};

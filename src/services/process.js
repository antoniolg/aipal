const { execFile } = require('child_process');

function shellQuote(value) {
  const escaped = String(value).replace(/'/g, String.raw`'\''`);
  return `'${escaped}'`;
}

function wrapCommandWithPty(command) {
  const python = 'import pty,sys; pty.spawn(["bash","-lc", sys.argv[1]])';
  return `python3 -c ${shellQuote(python)} ${shellQuote(command)}`;
}

function execLocal(cmd, args, options = {}) {
  const { timeout, maxBuffer, ...rest } = options;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout, maxBuffer, ...rest },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          if (timeout && err.killed) {
            const timeoutErr = new Error(`Command timed out after ${timeout}ms`);
            timeoutErr.code = 'ETIMEDOUT';
            timeoutErr.stderr = stderr;
            timeoutErr.stdout = stdout;
            return reject(timeoutErr);
          }
          return reject(err);
        }
        resolve(stdout || '');
      }
    );
  });
}

module.exports = {
  execLocal,
  shellQuote,
  wrapCommandWithPty,
};

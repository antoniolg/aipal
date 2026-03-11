const cp = require('child_process');

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
    cp.execFile(
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

function execLocalStreaming(cmd, args, options = {}) {
  const {
    timeout,
    maxBuffer,
    onStdout,
    onStderr,
    ...rest
  } = options;

  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, {
      ...rest,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;
    let timeoutHandle = null;

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }

    function finishError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }

    function appendChunk(target, chunk) {
      const next = target + chunk;
      if (maxBuffer && Buffer.byteLength(next, 'utf8') > maxBuffer) {
        const overflowErr = new Error(`Command output exceeded maxBuffer of ${maxBuffer} bytes`);
        overflowErr.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        try {
          child.kill('SIGKILL');
        } catch {}
        finishError(overflowErr);
        return target;
      }
      return next;
    }

    if (timeout) {
      timeoutHandle = setTimeout(() => {
        killedByTimeout = true;
        try {
          child.kill('SIGTERM');
        } catch {}
      }, timeout);
      if (typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    }

    if (child.stdout) {
      if (typeof child.stdout.setEncoding === 'function') {
        child.stdout.setEncoding('utf8');
      }
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        stdout = appendChunk(stdout, chunk);
        if (settled) return;
        if (typeof onStdout === 'function') {
          onStdout(chunk);
        }
      });
    }

    if (child.stderr) {
      if (typeof child.stderr.setEncoding === 'function') {
        child.stderr.setEncoding('utf8');
      }
      child.stderr.on('data', (chunk) => {
        if (settled) return;
        stderr = appendChunk(stderr, chunk);
        if (settled) return;
        if (typeof onStderr === 'function') {
          onStderr(chunk);
        }
      });
    }

    child.once('error', (err) => {
      finishError(err);
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (killedByTimeout) {
        const timeoutErr = new Error(`Command timed out after ${timeout}ms`);
        timeoutErr.code = 'ETIMEDOUT';
        timeoutErr.signal = signal;
        timeoutErr.stdout = stdout;
        timeoutErr.stderr = stderr;
        reject(timeoutErr);
        return;
      }

      if (code !== 0) {
        const err = new Error(`Command failed with exit code ${code}`);
        err.code = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve(stdout || '');
    });
  });
}

module.exports = {
  execLocal,
  execLocalStreaming,
  shellQuote,
  wrapCommandWithPty,
};

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { EventEmitter } = require('node:events');
const {
    execLocal,
    execLocalStreaming,
    shellQuote,
    terminateChildProcess,
    wrapCommandWithPty,
} = require('../../src/services/process');

test('process.js service', async (t) => {
    t.afterEach(() => {
        mock.restoreAll();
    });

    await t.test('shellQuote escapes single quotes correctly', () => {
        assert.equal(shellQuote('hello'), `'hello'`);
        assert.equal(shellQuote(`it's time`), `'it'\\''s time'`);
    });

    await t.test('wrapCommandWithPty wraps command in python script', () => {
        const wrapped = wrapCommandWithPty('echo "hello"');
        assert.ok(wrapped.startsWith('python3 -c '));
        assert.ok(wrapped.includes('pty.spawn'));
        assert.ok(wrapped.includes('echo "hello"'));
    });

    await t.test('execLocal resolves with stdout on success', async () => {
        mock.method(cp, 'execFile', (cmd, args, opts, cb) => {
            assert.equal(cmd, 'ls');
            assert.deepEqual(args, ['-l']);
            assert.equal(opts.timeout, 1000);
            cb(null, 'file1\nfile2\n', '');
        });

        const result = await execLocal('ls', ['-l'], { timeout: 1000 });
        assert.equal(result, 'file1\nfile2\n');
    });

    await t.test('execLocal rejects with error containing stdout/stderr on failure', async () => {
        const fakeError = new Error('Command failed');
        mock.method(cp, 'execFile', (_cmd, _args, _opts, cb) => {
            cb(fakeError, 'some output', 'some error');
        });

        await assert.rejects(
            () => execLocal('badcmd', []),
            (err) => {
                assert.equal(err.message, 'Command failed');
                assert.equal(err.stdout, 'some output');
                assert.equal(err.stderr, 'some error');
                return true;
            }
        );
    });

    await t.test('execLocal translates killed process with timeout to ETIMEDOUT error', async () => {
        const fakeError = new Error('Command failed');
        fakeError.killed = true; // Indicates it was killed (e.g. by timeout wrapper)

        mock.method(cp, 'execFile', (_cmd, _args, _opts, cb) => {
            cb(fakeError, 'partial out', 'partial err');
        });

        await assert.rejects(
            () => execLocal('sleep', ['10'], { timeout: 5000 }),
            (err) => {
                assert.equal(err.code, 'ETIMEDOUT');
                assert.equal(err.message, 'Command timed out after 5000ms');
                assert.equal(err.stdout, 'partial out');
                assert.equal(err.stderr, 'partial err');
                return true;
            }
        );
    });

    await t.test('execLocalStreaming streams stdout chunks and resolves with full stdout', async () => {
        let spawnedChild;
        mock.method(cp, 'spawn', (cmd, args, opts) => {
            assert.equal(cmd, 'bash');
            assert.deepEqual(args, ['-lc', 'echo hi']);
            assert.equal(opts.cwd, '/tmp/demo');
            assert.equal(opts.detached, true);

            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            child.pid = 123;

            process.nextTick(() => {
                child.stdout.emit('data', 'hello ');
                child.stdout.emit('data', 'world');
                child.emit('close', 0, null);
            });

            return child;
        });

        const chunks = [];
        const result = await execLocalStreaming('bash', ['-lc', 'echo hi'], {
            cwd: '/tmp/demo',
            onSpawn: (child) => {
                spawnedChild = child;
            },
            onStdout: (chunk) => chunks.push(chunk),
        });

        assert.equal(result, 'hello world');
        assert.deepEqual(chunks, ['hello ', 'world']);
        assert.equal(spawnedChild.pid, 123);
    });

    await t.test('terminateChildProcess kills the process group on Unix', () => {
        const child = { pid: 4321, kill: mock.fn() };
        const killMock = mock.method(process, 'kill', (pid, signal) => {
            assert.equal(pid, -4321);
            assert.equal(signal, 'SIGTERM');
        });

        terminateChildProcess(child, 'SIGTERM');

        assert.equal(killMock.mock.calls.length, 1);
        assert.equal(child.kill.mock.calls.length, 0);
    });

    await t.test('execLocalStreaming rejects with timeout error including partial output', async () => {
        const killCalls = [];
        mock.method(process, 'kill', (pid, signal) => {
            killCalls.push({ pid, signal });
        });
        mock.method(cp, 'spawn', () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            child.pid = 9876;

            process.nextTick(() => {
                child.stdout.emit('data', 'partial');
            });
            setTimeout(() => {
                child.emit('close', null, 'SIGTERM');
            }, 10);

            return child;
        });

        await assert.rejects(
            () => execLocalStreaming('bash', ['-lc', 'sleep 10'], { timeout: 5 }),
            (err) => {
                assert.equal(err.code, 'ETIMEDOUT');
                assert.equal(err.stdout, 'partial');
                assert.deepEqual(killCalls, [{ pid: -9876, signal: 'SIGTERM' }]);
                return true;
            }
        );
    });
});

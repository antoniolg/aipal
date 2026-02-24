const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createScriptService } = require('../../src/services/scripts');

test('scripts.js service', async (t) => {
    t.afterEach(() => {
        mock.restoreAll();
    });

    const mockExecLocal = mock.fn(async () => 'command output');
    const mockIsPathInside = mock.fn(() => true);
    const mockLastScriptOutputs = new Map();

    const options = {
        execLocal: mockExecLocal,
        isPathInside: mockIsPathInside,
        scriptNameRegex: /^[a-zA-Z0-9_-]+$/,
        scriptsDir: '/mock/scripts',
        scriptTimeoutMs: 5000,
        scriptContextMaxChars: 1000,
        lastScriptOutputs: mockLastScriptOutputs,
    };

    const scriptService = createScriptService(options);

    await t.test('runScriptCommand validates script name', async () => {
        await assert.rejects(
            () => scriptService.runScriptCommand('invalid name.sh', ''),
            /Invalid script name: invalid name.sh/
        );
    });

    await t.test('runScriptCommand validates path is inside scripts dir', async () => {
        mockIsPathInside.mock.mockImplementationOnce(() => false);
        await assert.rejects(
            () => scriptService.runScriptCommand('test-script', ''),
            (err) => {
                assert.ok(err.message.includes('Invalid script path:'));
                return true;
            }
        );
    });

    await t.test('runScriptCommand throws Script not found on ENOENT', async () => {
        mock.method(fs, 'access', async () => {
            const err = new Error('not found');
            err.code = 'ENOENT';
            throw err;
        });

        await assert.rejects(
            () => scriptService.runScriptCommand('test-script', ''),
            /Script not found: /
        );
    });

    await t.test('runScriptCommand throws Script not executable on EACCES', async () => {
        mock.method(fs, 'access', async () => {
            const err = new Error('permission denied');
            err.code = 'EACCES';
            throw err;
        });

        await assert.rejects(
            () => scriptService.runScriptCommand('test-script', ''),
            /Script not executable: /
        );
    });

    await t.test('runScriptCommand executes successfully', async () => {
        // access resolves normally (file exists & executable)
        mock.method(fs, 'access', async () => { });

        // Ensure mockExecLocal was reset
        mockExecLocal.mock.resetCalls();

        const output = await scriptService.runScriptCommand('my_script', '"argument one" two');

        assert.equal(output, 'command output');
        assert.equal(mockExecLocal.mock.calls.length, 1);

        // Check call arguments passed to execLocal
        const args = mockExecLocal.mock.calls[0].arguments;
        assert.equal(args[0], path.resolve('/mock/scripts', 'my_script'));
        assert.deepEqual(args[1], ['argument one', 'two']); // check splitArgs
        assert.equal(args[2].timeout, 5000);
    });
});

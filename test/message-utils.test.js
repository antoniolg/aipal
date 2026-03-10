const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  extractImageTokens,
  extractDocumentTokens,
  extractScheduleOnceTokens,
  isPathInside,
  buildPrompt,
  parseSlashCommand,
  markdownToTelegramHtml,
  chunkMarkdown,
} = require('../src/message-utils');

test('extractImageTokens keeps only images inside IMAGE_DIR', () => {
  const baseDir = path.join(os.tmpdir(), 'aipal-test-images');
  const inside = path.join(baseDir, 'img.png');
  const outside = path.join(os.tmpdir(), 'outside.png');
  const text = `hello [[image:${inside}]] [[image:${outside}]] [[image:relative.png]]`;
  const { cleanedText, imagePaths } = extractImageTokens(text, baseDir);
  assert.equal(cleanedText, 'hello');
  assert.deepEqual(imagePaths.sort(), [
    inside,
    path.join(baseDir, 'relative.png'),
  ].sort());
});

test('extractDocumentTokens keeps only documents inside DOCUMENT_DIR', () => {
  const baseDir = path.join(os.tmpdir(), 'aipal-test-docs');
  const inside = path.join(baseDir, 'guide.pdf');
  const outside = path.join(os.tmpdir(), 'outside.pdf');
  const text = `hello [[document:${inside}]] [[file:${outside}]] [[document:relative.pdf]]`;
  const { cleanedText, documentPaths } = extractDocumentTokens(text, baseDir);
  assert.equal(cleanedText, 'hello');
  assert.deepEqual(documentPaths.sort(), [
    inside,
    path.join(baseDir, 'relative.pdf'),
  ].sort());
});

test('extractScheduleOnceTokens parses schedule payloads and strips tokens', () => {
  const text = 'hello [[schedule_once:{"runAt":"2026-03-20T09:30:00+01:00","prompt":"Ping"}]] world';
  const { cleanedText, schedules, errors } = extractScheduleOnceTokens(text);
  assert.equal(cleanedText, 'hello  world');
  assert.equal(errors.length, 0);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].prompt, 'Ping');
});

test('isPathInside detects containment', () => {
  const baseDir = path.join(os.tmpdir(), 'aipal-test');
  assert.equal(isPathInside(baseDir, path.join(baseDir, 'file.txt')), true);
  assert.equal(isPathInside(baseDir, path.join(os.tmpdir(), 'other.txt')), false);
});

test('isPathInside handles symlinked base paths', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipal-symlink-'));
  const targetFile = path.join(baseDir, 'file.txt');
  fs.writeFileSync(targetFile, 'ok');
  const linkDir = `${baseDir}-link`;
  fs.symlinkSync(baseDir, linkDir, 'dir');
  try {
    assert.equal(isPathInside(linkDir, targetFile), true);
    assert.equal(isPathInside(linkDir, path.join(linkDir, 'file.txt')), true);
  } finally {
    try {
      if (fs.lstatSync(linkDir).isSymbolicLink()) {
        fs.unlinkSync(linkDir);
      } else {
        fs.rmSync(linkDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors in temp dirs.
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildPrompt includes image hints', () => {
  const baseDir = '/tmp/aipal/images';
  const docDir = '/tmp/aipal/documents';
  const prompt = buildPrompt(
    'hello',
    ['/tmp/aipal/images/a.png'],
    baseDir,
    '',
    [],
    docDir
  );
  assert.match(prompt, /User sent image file/);
  assert.match(prompt, /\[\[image:\/absolute\/path\]\]/);
  assert.match(prompt, /\[\[document:\/absolute\/path\]\]/);
  assert.match(prompt, /\[\[schedule_once:/);
});

test('buildPrompt includes slash context', () => {
  const baseDir = '/tmp/aipal/images';
  const docDir = '/tmp/aipal/documents';
  const prompt = buildPrompt('hello', [], baseDir, '/inbox output:\n1) foo', [], docDir);
  assert.match(prompt, /Context from last slash command output/);
  assert.match(prompt, /\/inbox output/);
});

test('parseSlashCommand parses args', () => {
  const parsed = parseSlashCommand('/inbox --max 3');
  assert.deepEqual(parsed, { name: 'inbox', args: '--max 3' });
});

test('parseSlashCommand handles bot suffix', () => {
  const parsed = parseSlashCommand('/inbox@mybot');
  assert.deepEqual(parsed, { name: 'inbox', args: '' });
});

test('markdownToTelegramHtml formats basic markdown', () => {
  const input = [
    '# Title',
    '',
    'Hello **bold** and _italic_ with `code`.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '[OpenAI](https://openai.com)',
  ].join('\n');
  const output = markdownToTelegramHtml(input);
  assert.match(output, /<b>Title<\/b>/);
  assert.match(output, /<b>bold<\/b>/);
  assert.match(output, /<i>italic<\/i>/);
  assert.match(output, /<code>code<\/code>/);
  assert.match(output, /<pre><code>const x = 1;\n<\/code><\/pre>/);
  assert.match(output, /<a href="https:\/\/openai.com">OpenAI<\/a>/);
});

test('chunkMarkdown keeps fences together when possible', () => {
  const input = ['```', 'line 1', 'line 2', '```', 'tail'].join('\n');
  const chunks = chunkMarkdown(input, 20);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /```/);
  assert.match(chunks[0], /line 2/);
  assert.equal(chunks[1], 'tail');
});

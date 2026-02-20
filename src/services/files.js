const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function createFileService(options) {
  const {
    execLocal,
    extensionFromMime,
    extensionFromUrl,
    imageCleanupIntervalMs,
    imageDir,
    imageTtlHours,
    whisperCmd,
    whisperLanguage,
    whisperModel,
    whisperTimeoutMs,
    documentCleanupIntervalMs,
    documentDir,
    documentTtlHours,
  } = options;

  async function downloadTelegramFile(ctx, payload, downloadOptions = {}) {
    const {
      dir = path.join(os.tmpdir(), 'aipal'),
      prefix = 'file',
      errorLabel = 'file',
    } = downloadOptions;
    const link = await ctx.telegram.getFileLink(payload.fileId);
    const url = typeof link === 'string' ? link : link.href;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${errorLabel} (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(dir, { recursive: true });
    const extFromName = payload.fileName ? path.extname(payload.fileName) : '';
    const ext =
      extFromName || extensionFromMime(payload.mimeType) || extensionFromUrl(url) || '.bin';
    const filePath = path.join(dir, `${prefix}-${randomUUID()}${ext}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async function transcribeAudio(audioPath) {
    const outputDir = path.join(os.tmpdir(), 'whisper-mlx');
    await fs.mkdir(outputDir, { recursive: true });
    const outputName = `whisper-${randomUUID()}`;
    const args = [
      audioPath,
      '--model',
      whisperModel,
      '--language',
      whisperLanguage,
      '--output-dir',
      outputDir,
      '--output-format',
      'txt',
      '--output-name',
      outputName,
      '--condition-on-previous-text',
      'False',
      '--word-timestamps',
      'True',
      '--hallucination-silence-threshold',
      '2',
    ];
    await execLocal(whisperCmd, args, { timeout: whisperTimeoutMs });
    const outputPath = path.join(outputDir, `${outputName}.txt`);
    const text = await fs.readFile(outputPath, 'utf8');
    return { text: text.trim(), outputPath };
  }

  async function safeUnlink(filePath) {
    if (!filePath) return;
    try {
      await fs.unlink(filePath);
    } catch {}
  }

  async function cleanupOldFiles(dir, maxAgeMs, label) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await safeUnlink(filePath);
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`${label} cleanup failed:`, err);
      }
    }
  }

  function startImageCleanup() {
    if (!Number.isFinite(imageTtlHours) || imageTtlHours <= 0) return;
    const maxAgeMs = imageTtlHours * 60 * 60 * 1000;
    const run = () => cleanupOldFiles(imageDir, maxAgeMs, 'Image');
    run();
    if (Number.isFinite(imageCleanupIntervalMs) && imageCleanupIntervalMs > 0) {
      const timer = setInterval(run, imageCleanupIntervalMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  }

  function startDocumentCleanup() {
    if (!Number.isFinite(documentTtlHours) || documentTtlHours <= 0) return;
    const maxAgeMs = documentTtlHours * 60 * 60 * 1000;
    const run = () => cleanupOldFiles(documentDir, maxAgeMs, 'Document');
    run();
    if (
      Number.isFinite(documentCleanupIntervalMs) &&
      documentCleanupIntervalMs > 0
    ) {
      const timer = setInterval(run, documentCleanupIntervalMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  }

  return {
    cleanupOldFiles,
    downloadTelegramFile,
    safeUnlink,
    startDocumentCleanup,
    startImageCleanup,
    transcribeAudio,
  };
}

module.exports = {
  createFileService,
};

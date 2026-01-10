const path = require('path');

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function formatError(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code: ${err.code}`);
  if (err.stderr) parts.push(`stderr: ${String(err.stderr).trim()}`);
  const message = parts.filter(Boolean).join('\n');
  return message || String(err);
}

function extractCommandValue(text) {
  if (!text) return '';
  return text.replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();
}

function extensionFromMime(mimeType) {
  if (!mimeType) return '';
  const normalized = mimeType.toLowerCase();
  if (normalized === 'audio/ogg') return '.ogg';
  if (normalized === 'audio/mpeg') return '.mp3';
  if (normalized === 'audio/mp4') return '.m4a';
  if (normalized === 'audio/x-m4a') return '.m4a';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '';
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname);
    return ext || '';
  } catch {
    return '';
  }
}

function getAudioPayload(message) {
  if (!message) return null;
  if (message.voice) {
    return {
      kind: 'voice',
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type || '',
      fileName: '',
    };
  }
  if (message.audio) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type || '',
      fileName: message.audio.file_name || '',
    };
  }
  if (message.document && String(message.document.mime_type || '').startsWith('audio/')) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || '',
      fileName: message.document.file_name || '',
    };
  }
  return null;
}

function getImagePayload(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: best.file_id,
      mimeType: 'image/jpeg',
      fileName: '',
    };
  }
  if (message.document && String(message.document.mime_type || '').startsWith('image/')) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || '',
      fileName: message.document.file_name || '',
    };
  }
  return null;
}

function isPathInside(baseDir, candidatePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidatePath);
  if (base === target) return true;
  return target.startsWith(base + path.sep);
}

function extractImageTokens(text, imageDir) {
  const imagePaths = [];
  const tokenRegex = /\[\[image:([^\]]+)\]\]/g;
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const raw = (match[1] || '').trim();
    if (!raw) continue;
    const normalized = raw.replace(/^file:\/\//, '');
    const resolved = path.isAbsolute(normalized) ? normalized : path.join(imageDir, normalized);
    if (isPathInside(imageDir, resolved)) {
      imagePaths.push(resolved);
    } else {
      console.warn('Ignoring image path outside IMAGE_DIR:', resolved);
    }
  }
  const cleanedText = text.replace(tokenRegex, '').trim();
  return { cleanedText, imagePaths };
}

function buildPrompt(prompt, imagePaths = [], imageDir) {
  const lines = [];
  const trimmed = (prompt || '').trim();
  if (trimmed) lines.push(trimmed);
  if (imagePaths.length > 0) {
    lines.push('User sent image file(s):');
    for (const imagePath of imagePaths) {
      lines.push(`- ${imagePath}`);
    }
    lines.push('Read images from those paths if needed.');
  }
  lines.push(
    `If you generate an image, save it under ${imageDir} and reply with [[image:/absolute/path]] so the bot can send it.`
  );
  return lines.join('\n');
}

module.exports = {
  chunkText,
  formatError,
  extractCommandValue,
  extensionFromMime,
  extensionFromUrl,
  getAudioPayload,
  getImagePayload,
  isPathInside,
  extractImageTokens,
  buildPrompt,
};

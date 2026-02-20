const os = require('os');
const path = require('path');

function readNumberEnv(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

const WHISPER_CMD = 'mlx_whisper';
const WHISPER_TIMEOUT_MS = 300000;
const WHISPER_MODEL = 'mlx-community/whisper-large-v3-turbo';
const WHISPER_LANGUAGE = 'es';

const IMAGE_DIR = path.resolve(path.join(os.tmpdir(), 'aipal', 'images'));
const IMAGE_TTL_HOURS = 24;
const IMAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const DOCUMENT_DIR = path.resolve(path.join(os.tmpdir(), 'aipal', 'documents'));
const DOCUMENT_TTL_HOURS = 24;
const DOCUMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const SCRIPTS_DIR =
  process.env.AIPAL_SCRIPTS_DIR ||
  path.join(os.homedir(), '.config', 'aipal', 'scripts');
const SCRIPT_TIMEOUT_MS = readNumberEnv(
  process.env.AIPAL_SCRIPT_TIMEOUT_MS,
  120000
);
const AGENT_TIMEOUT_MS = readNumberEnv(
  process.env.AIPAL_AGENT_TIMEOUT_MS,
  600000
);
const AGENT_MAX_BUFFER = readNumberEnv(
  process.env.AIPAL_AGENT_MAX_BUFFER,
  10 * 1024 * 1024
);
const FILE_INSTRUCTIONS_EVERY = readNumberEnv(
  process.env.AIPAL_FILE_INSTRUCTIONS_EVERY,
  10
);
const MEMORY_CURATE_EVERY = readNumberEnv(
  process.env.AIPAL_MEMORY_CURATE_EVERY,
  20
);
const MEMORY_RETRIEVAL_LIMIT = readNumberEnv(
  process.env.AIPAL_MEMORY_RETRIEVAL_LIMIT,
  8
);
const SHUTDOWN_DRAIN_TIMEOUT_MS = readNumberEnv(
  process.env.AIPAL_SHUTDOWN_DRAIN_TIMEOUT_MS,
  120000
);
const SCRIPT_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

module.exports = {
  AGENT_MAX_BUFFER,
  AGENT_TIMEOUT_MS,
  DOCUMENT_CLEANUP_INTERVAL_MS,
  DOCUMENT_DIR,
  DOCUMENT_TTL_HOURS,
  FILE_INSTRUCTIONS_EVERY,
  IMAGE_CLEANUP_INTERVAL_MS,
  IMAGE_DIR,
  IMAGE_TTL_HOURS,
  MEMORY_CURATE_EVERY,
  MEMORY_RETRIEVAL_LIMIT,
  SCRIPT_NAME_REGEX,
  SCRIPTS_DIR,
  SCRIPT_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  WHISPER_CMD,
  WHISPER_LANGUAGE,
  WHISPER_MODEL,
  WHISPER_TIMEOUT_MS,
  readNumberEnv,
};

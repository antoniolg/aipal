# Telegram Codex Tmux Bot

Minimal bot that connects Telegram with `codex` via `tmux`. Each message runs as a command in a tmux session and the output is extracted using markers.

## Requirements
- Node.js 18+ (uses native `fetch`)
- `tmux`
- `codex` in PATH (or configure `CODEX_TEMPLATE`)
- `parakeet-mlx` in PATH (audio transcription) + `ffmpeg`

## Install
```bash
git clone https://github.com/antoniolg/telegram-codex-tmux-bot.git
cd telegram-codex-tmux-bot
npm install
cp .env.example .env
```

## Configuration
Edit `.env` and set `TELEGRAM_BOT_TOKEN` (BotFather).

Optional variables (defaults in `.env.example`):
- `BOT_CONFIG_PATH`: path to a JSON config (defaults to `./config.json` if present).
- `AGENT`: agent key to use when JSON config is missing or does not specify one.
- `TMUX_SESSION_PREFIX`: per-chat session prefix.
- `TMUX_LINES`: captured pane lines (e.g. `-5000`).
- `CODEX_TIMEOUT_MS`: execution timeout.
- `CODEX_TEMPLATE`: full template (uses `{prompt}` and optional `{session}`).
- `CODEX_CMD` / `CODEX_ARGS`: alternative when not using a template.
- `PARAKEET_CMD`, `PARAKEET_MODEL`, `PARAKEET_TIMEOUT_MS`: transcription.
- `IMAGE_DIR`: local folder for incoming/outgoing images (default: system temp under `telegram-codex/images`).
- `IMAGE_TTL_HOURS`: auto-delete images older than this (default: 24). Set to `0` to disable.
- `IMAGE_CLEANUP_INTERVAL_MS`: cleanup interval (default: 3600000 / 1h).

### Agent config (JSON)
Create `config.json` (or point `BOT_CONFIG_PATH` to another file) to pick the agent and its command.

Example:
```json
{
  "model": "gpt-5.2",
  "thinking": "medium",
  "agent": "codex",
  "agents": {
    "codex": {
      "type": "codex",
      "cmd": "codex",
      "args": "--json --skip-git-repo-check",
      "template": "",
      "output": "codex-json",
      "session": { "strategy": "thread" },
      "modelArg": "--model",
      "thinkingArg": "--thinking"
    },
    "cloud-code": {
      "type": "generic",
      "cmd": "cloud-code",
      "args": "",
      "template": "cloud-code {prompt}",
      "output": "text",
      "session": { "strategy": "chat" },
      "modelArg": "",
      "thinkingArg": ""
    },
    "gemini-cly": {
      "type": "generic",
      "cmd": "gemini-cly",
      "args": "",
      "template": "gemini-cly {prompt}",
      "output": "text",
      "session": { "strategy": "chat" },
      "modelArg": "",
      "thinkingArg": ""
    }
  }
}
```
Templates can use `{model}` and `{thinking}` placeholders. If omitted, the bot appends `modelArg`/`thinkingArg` when set via `/model` or `/thinking`.

## Run
```bash
npm start
```
In Telegram: send text or audio. Use `/reset` to clear context and kill the tmux session for that chat.
Use `/model <name>` and `/thinking <level>` to set global options (persisted to `config.json`).

## How it works
- Creates a tmux session per chat (`codexbot-<chatId>`)
- Runs the configured agent command inside tmux and captures the output between markers
- Captures the pane and extracts text between markers
- If the agent outputs Codex-style JSON, stores `thread_id` and uses `exec resume` to keep conversation state
- If audio arrives, downloads it, transcribes with `parakeet-mlx`, and sends the transcript to codex
- If an image arrives, downloads it into `IMAGE_DIR` and includes its path in the prompt
- If codex generates an image, it should save it under `IMAGE_DIR` and reply with `[[image:/absolute/path]]` so the bot can send it

## Template examples
```
CODEX_TEMPLATE=codex exec --json {prompt}
```
```
CODEX_TEMPLATE=codex exec --json --model gpt-5.2 {prompt}
```
```
# With resume (use {session} if you want to control the format)
CODEX_TEMPLATE=codex exec resume {session} --json {prompt}
```

## Notes
- Defaults to `codex exec --json` (non-interactive). If your CLI does not support it, adjust `CODEX_CMD`, `CODEX_ARGS`, or `CODEX_TEMPLATE`.
- Keep the bot private or restrict access: each message executes local commands on your machine.
- Images are only sent back if the returned path is inside `IMAGE_DIR`.

## Troubleshooting
- `ENOENT parakeet-mlx`: install `parakeet-mlx` and ensure it is on PATH.
- `Timeout waiting for codex response`: increase `CODEX_TIMEOUT_MS` or reduce load.
- Telegram `ECONNRESET`: usually transient network, retry.

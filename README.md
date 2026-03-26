# Aipal: Telegram Agent Bot

![CI](https://github.com/antoniolg/aipal/actions/workflows/ci.yml/badge.svg?branch=main)

![Aipal](docs/assets/aipal.jpg)

Minimal Telegram bot that forwards messages to a local agent (Codex by default). Each message runs locally and the output is sent back to the chat.

## What it does
- Runs your configured CLI agent for every message
- Supports both shell-driven agents and `codex app-server` as backends
- Queues requests per chat to avoid overlapping runs
- Keeps agent session state per agent when JSON output is detected
- Handles text, audio (via `mlx_whisper`), images, and documents
- Supports `/thinking`, `/agent`, and `/cron` for runtime tweaks
- Surfaces `codex-app` approval requests directly in Telegram with inline buttons

## Requirements
- Node.js 24+
- Agent executable on PATH (default: `codex`; also supports `codex app-server`, `claude`, `gemini`, and `opencode`)
- Audio (optional): `mlx_whisper` (`mlx-whisper`) + `ffmpeg`

## Quick start
```bash
git clone https://github.com/antoniolg/aipal.git
cd aipal
npm install
cp .env.example .env
```

1. Create a Telegram bot with BotFather and get the token.
2. Set `TELEGRAM_BOT_TOKEN` in `.env`.
3. Start the bot:

```bash
npm start
```

Open Telegram, send `/start`, then any message.
At startup, Aipal also syncs the built-in bot commands to Telegram automatically for both private chats and group chats.

## Usage (Telegram)
- Text: send a message and get the agent response
- Audio: send a voice note or audio file (transcribed with `mlx_whisper`)
- Images: send a photo or image file (caption becomes the prompt)
- Documents: send a file (caption becomes the prompt)
- `/reset`: clear the current agent session (drops the stored session id for this agent) and trigger memory curation
- `/thinking <level>`: set reasoning effort (mapped to `model_reasoning_effort`) for this session
- `/agent <name>`: set the agent backend
    - In root: sets global agent (persisted in `config.json`)
    - In a topic: sets an override for this topic (persisted in `agent-overrides.json`)
- `/agent default`: clear agent override for the current topic and return to global agent
- `/reset`: clear the current agent session for this topic (drops the stored session id for this agent)
- `/model [model_id|reset]`: view/set/reset the model for the current agent (persisted in `config.json`)
- `/memory [status|tail [n]|search <query>|curate]`: inspect, search, and curate automatic memory
- `/cron [list|reload|chatid|assign|unassign|run <jobId>|inspect <jobId>]`: manage cron jobs (see below)
- `/later <ISO-8601 datetime> | <prompt>`: schedule a one-shot future run
- `/runs [jobId] [n]`: show recent cron executions across jobs
- `/help`: list available commands and scripts
- `/document_scripts confirm`: generate short descriptions for scripts (writes `scripts.json`; requires `ALLOWED_USERS`)
- `/<script> [args]`: run an executable script from `~/.config/aipal/scripts`

### Script metadata (scripts.json)
Scripts can define metadata in `scripts.json` (stored inside `AIPAL_SCRIPTS_DIR`) to add descriptions or LLM post-processing.

Example:
```json
{
  "scripts": {
    "xbrief": {
      "description": "Filter briefing to AI/LLMs",
      "llm": {
        "prompt": "Filter the briefing to keep only AI and LLM items.\nRemove everything that is not AI without inventing or omitting anything relevant.\nMerge duplicates (same link or same content).\nKeep all sections and preserve links in [link](...) format.\nIf a section ends up empty, mark it as \"(No results)\".\nRespond in Spanish, direct and without filler."
      }
    }
  }
}
```

If `llm.prompt` is present, the script output is passed to the agent as context and the bot replies with the LLM response (not the raw output).

### Telegram Topics
Aipal supports Telegram Topics. Sessions and agent overrides are kept per-topic.
- Messages in the main chat ("root") have their own sessions.
- Messages in any topic thread have their own independent sessions.
- You can set a different agent for each topic using `/agent <name>`.

### Codex App Server
If you select `/agent codex-app`, Aipal talks to `codex app-server` over stdio instead of invoking the legacy shell flow. Thread state is still isolated per `chatId:topicId:agentId`, so `codex` and `codex-app` can coexist in the same chat without sharing sessions or memory logs.

When `codex-app` requests a command or file-change approval, Aipal sends an inline approval card to Telegram. You can approve once, approve for the session, reject, or cancel without leaving the chat.

### Cron jobs
Cron jobs are loaded from `~/.config/aipal/cron.json` (or `$XDG_CONFIG_HOME/aipal/cron.json`) and are sent to a single Telegram chat (the `cronChatId` configured in `config.json`).

The scheduler keeps durable execution state in `~/.config/aipal/cron-state.json`, so pending retries and recent execution metadata survive process restarts.
It also sends Telegram alerts when runs enter DLQ or when old schedule slots fall outside the configured catch-up window.

- `/cron chatid`: prints your chat ID (use this value as `cronChatId`).
- `/cron list`: lists configured jobs.
- `/cron reload`: reloads `cron.json` without restarting the bot.
- `/cron run <jobId>`: triggers one job immediately using its configured target chat/topic.
- `/cron inspect <jobId>`: shows current scheduler state, lag, recent attempts, and next scheduled slots.
- `/runs [jobId] [n]`: shows the latest persisted cron attempts, including retries and failures.

Each job can optionally define:
- `catchupWindowSeconds`: how far back the scheduler should recover missed slots after downtime (default: `600`).
- `maxAttempts`: max execution attempts before the run is marked failed (default: `3`).
- `retryDelaySeconds`: base delay before the first retry (default: `30`).
- `retryBackoffFactor`: multiplier applied to subsequent retry delays (default: `2`).

### One-shot schedules
For one-time future tasks, use `/later` instead of creating a fake cron:

```text
/later 2026-03-15T09:30:00+01:00 | Recuérdame revisar la propuesta de AI Expert.
```

You can also ask the chatbot naturally to schedule something once in the future. When the model decides to do that, the bot will create a persisted one-shot run automatically.

- `/later list`: shows pending one-shot schedules.
- `/later cancel <runId>`: cancels a pending one-shot schedule.

One-shot schedules are stored in `~/.config/aipal/scheduled-runs.json` (or `$XDG_CONFIG_HOME/aipal/scheduled-runs.json`) and use the same retry/DLQ alert model as cron runs.

### Images in responses
If the agent generates an image, save it under the image folder (default: OS temp under `aipal/images`) and reply with:
```
[[image:/absolute/path]]
```
The bot will send the image back to Telegram.

### Documents in responses
If the agent generates a document (or needs to send a file), save it under the documents folder (default: OS temp under `aipal/documents`) and reply with:
```
[[document:/absolute/path]]
```
The bot will send the document back to Telegram.

## Configuration
The only required environment variable is `TELEGRAM_BOT_TOKEN` in `.env`.

Optional:
- `AIPAL_SCRIPTS_DIR`: directory for slash scripts (default: `~/.config/aipal/scripts`)
- `AIPAL_SCRIPT_TIMEOUT_MS`: timeout for slash scripts (default: 120000)
- `AIPAL_AGENT_POST_FINAL_GRACE_MS`: grace period after streaming a final Codex response before terminating a lingering local agent process (default: 2500)
- `AIPAL_MEMORY_CURATE_EVERY`: auto-curate memory after N captured events (default: 20)
- `AIPAL_MEMORY_RETRIEVAL_LIMIT`: max retrieved memory lines injected per request (default: 8)
- `ALLOWED_USERS`: comma-separated list of Telegram user IDs allowed to interact with the bot (if unset/empty, bot is open to everyone)

## Config file (optional)
The bot stores `/agent` in a JSON file at:
`~/.config/aipal/config.json` (or `$XDG_CONFIG_HOME/aipal/config.json`).

Example:
```json
{
  "agent": "codex-app",
  "models": {
    "codex-app": "gpt-5.4-codex"
  },
  "cronChatId": 123456789
}
```

See `docs/configuration.md` for details.

## Bootstrap files (optional)
If `soul.md`, `tools.md`, and/or `memory.md` exist next to `config.json`, their contents are injected into the first prompt of a new conversation in this order:
1. `soul.md`
2. `tools.md`
3. `memory.md`

Location:
`~/.config/aipal/soul.md`, `~/.config/aipal/tools.md`, and `~/.config/aipal/memory.md` (or under `$XDG_CONFIG_HOME/aipal/`).

### Automatic memory capture
- Every interaction is captured automatically in per-thread files under `~/.config/aipal/memory/threads/*.jsonl` (or `$XDG_CONFIG_HOME/aipal/memory/threads/*.jsonl`).
- Memory is isolated by `chatId:topicId:agentId` to avoid collisions across agents and topics.
- `memory.md` remains the global curated memory. The bot can curate it automatically and via `/memory curate`.
- Retrieval (iteration 1): lexical + recency retrieval over captured thread events is injected into prompts automatically, mixing local and global memory scope.
- Captured events are indexed in SQLite (`memory/index.sqlite`) for faster and broader retrieval across topics.
- `/memory status` shows memory health, `/memory tail` shows recent events, `/memory search` lets you inspect retrieval hits.

## Security notes
This bot executes local commands on your machine. Run it only on trusted hardware, keep the bot private, and avoid sharing the token.

To restrict access, set `ALLOWED_USERS` in `.env` to a comma-separated list of Telegram user IDs. Unauthorized users are ignored (no reply).

## How it works
- For shell-backed agents, builds a base64-encoded prompt and executes locally via `bash -lc`
- For `codex-app`, maintains a persistent `codex app-server --session-source aipal` process and streams JSON-RPC events
- Stores thread/session ids per agent so legacy `codex` and `codex-app` do not collide
- Audio is downloaded, transcribed, then forwarded as text
- Images are downloaded into the image folder and included in the prompt

## Troubleshooting
- `ENOENT mlx_whisper`: install `mlx-whisper` and ensure `mlx_whisper` is on PATH.
- `Error processing response.`: check that your selected agent is installed and accessible on PATH.
- `Codex app-server exited`: check that the installed `codex` binary supports `app-server` and that it starts correctly with `codex app-server --session-source aipal`.
- Telegram `ECONNRESET`: usually transient network, retry.

## License
MIT. See `LICENSE`.

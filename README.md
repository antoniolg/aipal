# Aipal: Telegram Codex Bot

![CI](https://github.com/antoniolg/aipal/actions/workflows/ci.yml/badge.svg?branch=main)

![Aipal](docs/assets/aipal.jpg)

Minimal Telegram bot that forwards messages to a local CLI agent (Codex by default). Each message is executed locally and the output is sent back to the chat.

## What it does
- Runs your configured CLI agent for every message
- Queues requests per chat to avoid overlapping runs
- Keeps agent session state per agent when JSON output is detected
- Handles text, audio (via Parakeet), images, and documents
- Supports `/thinking`, `/agent`, and `/cron` for runtime tweaks

## Requirements
- Node.js 18+
- Agent CLI on PATH (default: `codex`, or `claude` / `gemini` / `opencode` when configured)
- Audio (optional): `parakeet-mlx` + `ffmpeg`

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

## Usage (Telegram)
- Text: send a message and get the agent response
- Audio: send a voice note or audio file (transcribed with Parakeet)
- Images: send a photo or image file (caption becomes the prompt)
- Documents: send a file (caption becomes the prompt)
- `/reset`: clear the current agent session (drops the stored session id for this agent)
- `/thinking <level>`: set reasoning effort (mapped to `model_reasoning_effort`) for this session
- `/agent <name>`: set the CLI agent
    - In root: sets global agent (persisted in `config.json`)
    - In a topic: sets an override for this topic (persisted in `agent-overrides.json`)
- `/agent default`: clear agent override for the current topic and return to global agent
- `/reset`: clear the current agent session for this topic (drops the stored session id for this agent)
- `/model [model_id]`: view/set the model for the current agent (persisted in `config.json`)
- `/cron [list|reload|chatid]`: manage cron jobs (see below)
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

### Cron jobs
Cron jobs are loaded from `~/.config/aipal/cron.json` (or `$XDG_CONFIG_HOME/aipal/cron.json`) and are sent to a single Telegram chat (the `cronChatId` configured in `config.json`).

- `/cron chatid`: prints your chat ID (use this value as `cronChatId`).
- `/cron list`: lists configured jobs.
- `/cron reload`: reloads `cron.json` without restarting the bot.

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
- `ALLOWED_USERS`: comma-separated list of Telegram user IDs allowed to interact with the bot (if unset/empty, bot is open to everyone)

## Config file (optional)
The bot stores `/agent` in a JSON file at:
`~/.config/aipal/config.json` (or `$XDG_CONFIG_HOME/aipal/config.json`).

Example:
```json
{
  "agent": "codex",
  "cronChatId": 123456789
}
```

See `docs/configuration.md` for details.

## Memory + soul files (optional)
If `soul.md` and/or `memory.md` exist next to `config.json`, their contents are injected into the first prompt of a new conversation (`soul.md` first, then `memory.md`).

Location:
`~/.config/aipal/soul.md` and `~/.config/aipal/memory.md` (or under `$XDG_CONFIG_HOME/aipal/`).

## Security notes
This bot executes local commands on your machine. Run it only on trusted hardware, keep the bot private, and avoid sharing the token.

To restrict access, set `ALLOWED_USERS` in `.env` to a comma-separated list of Telegram user IDs. Unauthorized users are ignored (no reply).

## How it works
- Builds a shell command with a base64-encoded prompt to avoid quoting issues
- Executes the command locally via `bash -lc`
- If the agent outputs Codex-style JSON, stores `thread_id` and uses `exec resume`
- Audio is downloaded, transcribed, then forwarded as text
- Images are downloaded into the image folder and included in the prompt

## Troubleshooting
- `ENOENT parakeet-mlx`: install `parakeet-mlx` and ensure it is on PATH.
- `Error processing response.`: check that `codex` is installed and accessible on PATH.
- Telegram `ECONNRESET`: usually transient network, retry.

## License
MIT. See `LICENSE`.

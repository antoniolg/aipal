# Aipal: Telegram Codex Bot

![Aipal](docs/assets/aipal.jpg)

Minimal Telegram bot that forwards messages to a local CLI agent (Codex by default). Each message is executed locally and the output is sent back to the chat.

## What it does
- Runs your configured CLI agent for every message
- Queues requests per chat to avoid overlapping runs
- Keeps Codex thread state when JSON output is detected
- Handles text, audio (via Parakeet), and images
- Supports `/model` and `/thinking` to tweak the agent at runtime

## Requirements
- Node.js 18+
- Agent CLI on PATH (default: `codex`)
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
- `/reset`: clear the chat session (drops the Codex thread id)
- `/model <name>`: set the model (persisted in `config.json`)
- `/thinking <level>`: set thinking level (persisted in `config.json`)

### Images in responses
If the agent generates an image, save it under the image folder (default: OS temp under `aipal/images`) and reply with:
```
[[image:/absolute/path]]
```
The bot will send the image back to Telegram.

## Configuration
The only required environment variable is `TELEGRAM_BOT_TOKEN` in `.env`.

## Config file (optional)
The bot stores `/model` and `/thinking` in a JSON file at:
`~/.config/aipal/config.json` (or `$XDG_CONFIG_HOME/aipal/config.json`).

Example:
```json
{
  "model": "gpt-5.2",
  "thinking": "medium"
}
```

See `docs/configuration.md` for details.

## Security notes
This bot executes local commands on your machine. Run it only on trusted hardware, keep the bot private, and avoid sharing the token. There is no built-in allowlist: anyone who can message the bot can execute the configured command.

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

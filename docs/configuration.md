# Configuration (config.json + memory.md + soul.md + cron.json)

This bot stores a minimal JSON config with the values set by `/agent`.

## Location
- `~/.config/aipal/config.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/config.json`

## Schema
```json
{
  "agent": "codex",
  "models": {
    "codex": "gpt-5"
  },
  "cronChatId": 123456789
}
```

## Fields
- `agent`: which CLI to run (`codex`, `claude`, `gemini`, or `opencode`).
- `models` (optional): a map of agent id → model id, set via `/model`.
- `cronChatId` (optional): Telegram chat id used for cron job messages. You can get it from `/cron chatid`.

If the file is missing, all values are unset and the bot uses defaults.

## Environment variables
- `ALLOWED_USERS` (optional): comma-separated list of Telegram user IDs allowed to use the bot. If unset/empty, the bot is open to everyone.

## Memory file (optional)
If `memory.md` exists alongside `config.json`, its contents are injected into the very first prompt of a new conversation (i.e. when there is no active session/thread).

Location:
- `~/.config/aipal/memory.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory.md`

## Soul file (optional)
If `soul.md` exists alongside `config.json`, its contents are injected into the very first prompt of a new conversation, before `memory.md`.

Location:
- `~/.config/aipal/soul.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/soul.md`

## Cron jobs file (optional)
Cron jobs live in a separate file:
- `~/.config/aipal/cron.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/cron.json`

Schema:
```json
{
  "jobs": [
    {
      "id": "daily-summary",
      "enabled": true,
      "cron": "0 9 * * *",
      "timezone": "Europe/Madrid",
      "prompt": "Dame un resumen del día con mis tareas pendientes."
    }
  ]
}
```

Notes:
- Jobs are only scheduled when `cronChatId` is set in `config.json`.
- Use `/cron reload` after editing `cron.json` to apply changes without restarting the bot.

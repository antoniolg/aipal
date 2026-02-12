# Configuration (config.json + memory.md + soul.md + cron.json + memory state)

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

## Agent Overrides file (optional)
When you use `/agent <name>` inside a Telegram Topic, the bot stores an override for that specific topic in:
- `~/.config/aipal/agent-overrides.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/agent-overrides.json`

Schema:
```json
{
  "chatId:topicId": "agentId"
}
```

## Memory file (optional)
If `memory.md` exists alongside `config.json`, its contents are injected into the very first prompt of a new conversation (i.e. when there is no active session/thread).

Location:
- `~/.config/aipal/memory.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory.md`

## Automatic memory capture
Every conversation is captured automatically into per-thread JSONL files:

- `~/.config/aipal/memory/threads/*.jsonl`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/threads/*.jsonl`

The key format is `chatId:topicId:agentId`, so multiple agents can write memory in parallel without sharing raw logs.

Curated memory state is stored in:
- `~/.config/aipal/memory/state.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/state.json`

Environment knobs:
- `AIPAL_MEMORY_CURATE_EVERY`: auto-curate memory after N new captured events (default: `20`).
- `AIPAL_MEMORY_RETRIEVAL_LIMIT`: maximum number of retrieved memory lines injected per request (default: `8`).

Retrieval currently mixes scopes (`same-thread`, `same-topic`, `same-chat`, `global`) so prompts can include both local continuity and useful cross-topic memory when available.

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

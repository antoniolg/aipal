# Configuration (config.json + soul.md + tools.md + memory.md + cron.json + cron-state.json + scheduled-runs.json + memory state)

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
- `models` (optional): a map of agent id → model id, set via `/model` and cleared per-agent via `/model reset`.
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

## Bootstrap files (optional)
When present, these files are injected into the very first prompt of a new conversation (no active session/thread) in this order:
1. `soul.md`
2. `tools.md`
3. `memory.md`

## Memory file (optional)
If `memory.md` exists alongside `config.json`, its contents are injected during bootstrap (after `soul.md` and `tools.md`).

Location:
- `~/.config/aipal/memory.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory.md`

## Automatic memory capture
Every conversation is captured automatically into per-thread JSONL files:

- `~/.config/aipal/memory/threads/*.jsonl`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/threads/*.jsonl`

The key format is `chatId:topicId:agentId`, so multiple agents can write memory in parallel without sharing raw logs.

An SQLite index is also maintained automatically:
- `~/.config/aipal/memory/index.sqlite`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/index.sqlite`

Curated memory state is stored in:
- `~/.config/aipal/memory/state.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/memory/state.json`

Environment knobs:
- `AIPAL_AGENT_POST_FINAL_GRACE_MS`: grace period after a streamed final answer before Aipal terminates a lingering agent subprocess (default: `2500`).
- `AIPAL_MEMORY_CURATE_EVERY`: auto-curate memory after N new captured events (default: `20`).
- `AIPAL_MEMORY_RETRIEVAL_LIMIT`: maximum number of retrieved memory lines injected per request (default: `8`).

Retrieval currently mixes scopes (`same-thread`, `same-topic`, `same-chat`, `global`) so prompts can include both local continuity and useful cross-topic memory when available.

## Soul file (optional)
If `soul.md` exists alongside `config.json`, its contents are injected first during bootstrap (before `tools.md` and `memory.md`).

Location:
- `~/.config/aipal/soul.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/soul.md`

## Tools file (optional)
If `tools.md` exists alongside `config.json`, its contents are injected during bootstrap after `soul.md` and before `memory.md`.

Location:
- `~/.config/aipal/tools.md`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/tools.md`

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
- Missed slots are materialized during the next scheduler tick, capped by each job's `catchupWindowSeconds` (default: `600`).
- Failed runs are retried with exponential backoff using `maxAttempts`, `retryDelaySeconds`, and `retryBackoffFactor`.

Optional per-job fields:
```json
{
  "jobs": [
    {
      "id": "daily-summary",
      "enabled": true,
      "cron": "0 9 * * *",
      "timezone": "Europe/Madrid",
      "prompt": "Dame un resumen del día con mis tareas pendientes.",
      "catchupWindowSeconds": 600,
      "maxAttempts": 3,
      "retryDelaySeconds": 30,
      "retryBackoffFactor": 2
    }
  ]
}
```

## Cron state file
Scheduler runtime state is stored separately in:
- `~/.config/aipal/cron-state.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/cron-state.json`

This file keeps the last scheduled slot, pending retries, a short recent run history, DLQ entries, missed-schedule alert markers, and the latest success/failure timestamps for each job so the scheduler can recover after restarts, avoid duplicate alerts, and power `/runs` / `/cron inspect`.

## One-shot schedules file
One-time future runs created via `/later` or by the chatbot are stored in:
- `~/.config/aipal/scheduled-runs.json`
- If `XDG_CONFIG_HOME` is set, it uses `$XDG_CONFIG_HOME/aipal/scheduled-runs.json`

Schema:
```json
{
  "runs": [
    {
      "id": "once-123",
      "runAt": "2026-03-15T08:30:00.000Z",
      "runAfter": "2026-03-15T08:30:00.000Z",
      "prompt": "Recuérdame revisar la propuesta de AI Expert.",
      "chatId": -1001234567890,
      "topicId": 42,
      "agent": "codex",
      "status": "pending",
      "attempt": 0,
      "maxAttempts": 3,
      "retryDelaySeconds": 30,
      "retryBackoffFactor": 2
    }
  ]
}
```

Notes:
- One-shot schedules use the same execution pipeline and retry policy style as cron runs.
- `status` transitions through `pending` -> `running` / `retry_scheduled` -> `succeeded` or `dead_letter`.

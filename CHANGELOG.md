# Changelog

All notable changes to this project will be documented in this file.

## [0.2.1] - 2026-02-12
### Added
- Automatic memory capture per conversation/agent into `memory/threads/*.jsonl`.
- `/memory` command with `status`, `tail`, `search`, and `curate` subcommands.
- Thread-specific memory bootstrap on the first turn of a new agent session.
- Retrieval iteration 1: lexical + recency memory retrieval injected into prompts with mixed-scope selection (same thread/topic + global), plus `/memory search`.

### Changed
- `memory.md` now supports an auto-generated section (between markers) curated from thread events while preserving manual notes.
- `/reset` now triggers immediate memory curation after clearing the session thread.

### Documentation
- Added automatic memory capture and curation details in `README.md` and `docs/configuration.md`.

## [0.2.0] - 2026-02-03
### Added
- LLM post-processing for slash scripts via `scripts.json` metadata (`llm.prompt`).
- `/help` marks scripts that use LLM post-processing with an `[LLM]` tag.

### Changed
- Slash commands can now route output through the agent based on script metadata.
- Removed the hardcoded `/xbrief` handler in favor of metadata-driven behavior.

### Documentation
- Documented `llm.prompt` usage for scripts.

## [0.1.8] - 2026-01-26
### Added
- `ALLOWED_USERS` environment variable to restrict bot access to an allowlist of Telegram user IDs.
- `/help` command to list built-in commands and executable scripts.
- `/document_scripts confirm` command to generate short script descriptions and persist them to `scripts.json`.
- `opencode` agent integration.
- `/model` command to view/set the model for the current agent (persisted in `config.json`).

### Changed
- If an agent exits non-zero but produces usable stdout, the bot returns that output instead of failing hard.

### Documentation
- Fixed `AIPAL_SCRIPTS_DIR` default path typo.
- Thanks @JcMinarro for the contributions in this release.

## [0.1.7] - 2026-01-25
### Added
- Internal cron scheduler for scheduled tasks within the same bot session.
- `/cron` command to list jobs, reload config, and get chat ID.
- Cron jobs config in `~/.config/aipal/cron.json`.

## [0.1.6] - 2026-01-21
### Added
- Gemini sessions are resumed by looking up the latest `gemini --list-sessions` entry.

## [0.1.5] - 2026-01-20
### Added
- Agent registry with adapters for Codex, Claude (headless), and Gemini.

### Changed
- Claude runs in headless mode with a PTY wrapper to avoid hangs.
- Gemini runs in headless JSON mode with YOLO auto-approval.
- `/model` support removed; model is no longer passed between CLIs.

## [0.1.4] - 2026-01-20
### Added
- Load optional memory.md into the first prompt of a new conversation.

### Documentation
- Document memory.md alongside config.json.

## [0.1.3] - 2026-01-15
### Added
- Reply with transcript for audio messages.

### Changed
- Add timestamps to bot logs.

### Documentation
- Update local agent notes.

## [0.1.2] - 2026-01-13
- Earlier changes were tracked only in GitHub releases.

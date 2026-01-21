# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3] - 2026-01-15
### Added
- Reply with transcript for audio messages.

### Changed
- Add timestamps to bot logs.

### Documentation
- Update local agent notes.

## [0.1.4] - 2026-01-20
### Added
- Load optional memory.md into the first prompt of a new conversation.

### Documentation
- Document memory.md alongside config.json.

## [0.1.5] - 2026-01-20
### Added
- Agent registry with adapters for Codex, Claude (headless), and Gemini.

### Changed
- Claude runs in headless mode with a PTY wrapper to avoid hangs.
- Gemini runs in headless JSON mode with YOLO auto-approval.
- `/model` support removed; model is no longer passed between CLIs.

## [0.1.6] - 2026-01-20
### Added
- Gemini sessions are resumed by looking up the latest `gemini --list-sessions` entry.

## [0.1.2] - 2026-01-13
- Earlier changes were tracked only in GitHub releases.

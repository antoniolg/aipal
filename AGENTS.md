# Local AGENTS Overrides

Tone:

- Personal assistant vibe: close, friendly, helpful.
- Warm, casual; light slang ok.
- Mirror user tone: match slang/jargon and phrasing to the interlocutor.

Style:

- Offer to help with next step.
- Ask when needed.

Development logs:

- `npm run dev` mirrors stdout and stderr to `.logs/dev.log` while keeping the same output visible in the terminal.
- When diagnosing development failures, inspect `.logs/dev.log` first. The file is reset each time the development watcher starts.
- Set `AIPAL_DEV_LOG` to override the log path when needed.

# telegram-minions — Claude guidance

## Secret and token safety

**Never read, log, print, or include `.env` contents in any output, commit, or message.**

- `.env` is gitignored. Never stage or commit it under any name.
- Never echo `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, or any credential value.
- Use `.env.example` with placeholder values as the only committed secrets template.

## Project overview

Telegram-controlled Goose coding agents on fly.io. The Dispatcher polls Telegram for `/task` commands, spawns Goose sessions for each task, and the Observer streams Goose events back to Telegram forum topics.

## Key files

| File | Purpose |
|---|---|
| `src/main.ts` | Entry point — starts Dispatcher with SIGTERM/SIGINT handlers |
| `src/dispatcher.ts` | Telegram poll loop, `/task` parsing, session lifecycle |
| `src/session.ts` | SessionHandle — wraps a single `goose run` subprocess |
| `src/observer.ts` | Translates Goose stream-json events to Telegram messages |
| `src/telegram.ts` | Telegram Bot API client (sendMessage, editMessage, topics) |
| `src/format.ts` | HTML message formatters for Telegram |
| `src/config.ts` | Centralized config from env vars |
| `src/slugs.ts` | Deterministic adjective-noun slug generator |
| `src/types.ts` | TypeScript types for Goose events and Telegram API |
| `goose/config.yaml` | Goose agent configuration (mode, extensions, limits) |

## Development

```sh
npm install
npm run typecheck        # type check
npm run dev              # run directly with tsx (requires .env)
npm run build            # compile to dist/
```

## Task command format

```
/task https://github.com/org/repo Description of the coding task
/task Description of the task (no repo, uses current workspace)
```

## Goose stream-json event schema

Events are one JSON object per line (NDJSON). Types:
- `{"type":"message","message":{"role":"assistant","content":[...]}}` — text and tool calls
- `{"type":"notification","extensionId":"...","message":"..."}` — MCP logs
- `{"type":"error","error":"..."}` — errors
- `{"type":"complete","total_tokens":123}` — session end

Content block types in `message.content`:
- `{"type":"text","text":"..."}` — assistant text output
- `{"type":"toolRequest","id":"...","toolCall":{"name":"...","arguments":{...}}}` — tool calls
- `{"type":"toolResponse","id":"...","toolResult":{...}}` — tool results

## Fly.io deployment

```sh
fly secrets set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... TELEGRAM_CHAT_ID=... ALLOWED_USER_IDS=...
fly volumes create workspace_data --size 10
fly deploy
```

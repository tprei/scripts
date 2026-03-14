# telegram-notify — LLM setup reference

Machine-readable reference for setting up and understanding this project. Written for LLMs onboarding into this codebase.

---

## What it does

Fires on both the `Stop` and `SessionStart` Claude Code hooks. Reads stdin JSON, enriches with git/tmux/hostname context, then:

- **Always** (when `LISTENER_ENABLED`): upserts the current session and pane ID into `sessions-cache.json`
- **Stop only**: sends a formatted HTML notification to a Telegram supergroup with forum topics

Each unique project name (basename of `cwd`) gets its own topic thread, created automatically on first use.

When `LISTENER_ENABLED=true`, a separate `listener.ts` process long-polls `getUpdates`, looks up the session for the incoming message's thread, and injects the text into the active tmux pane via `safe-inject.ts`. Before injection, a `z-claude` classifier call checks whether the message attempts prompt injection or destructive actions.

---

## Source map

| File | Role |
|---|---|
| `src/notify.ts` | Entry point. Reads stdin, resolves topic, sends message. |
| `src/telegram.ts` | Telegram API client. Splits long messages into reply chains. |
| `src/topics.ts` | Forum topic manager. Creates/caches `project → topic_id` mappings. |
| `src/format.ts` | Builds the HTML notification string. |
| `src/context.ts` | Reads git branch, tmux window name, hostname. |
| `src/transcript.ts` | Extracts last user instruction or slash command from transcript JSONL. |
| `src/types.ts` | `StopHookInput` interface matching Claude Code hook schema (`hook_event_name: string`, Stop-specific fields optional). |
| `src/listener.ts` | Long-polls Telegram `getUpdates`, routes messages to the correct tmux pane. |
| `src/safe-inject.ts` | Sanitizes and classifier-checks incoming text before `tmux send-keys`. Calls `/home/prei/bin/z-claude`. |
| `src/sessions.ts` | Reads/writes `sessions-cache.json` mapping topic thread IDs to session/pane info. |
| `topics-cache.json` | Runtime cache mapping project names to Telegram topic IDs. Gitignored. |
| `sessions-cache.json` | Runtime cache mapping topic thread IDs to `{ session_id, pane_id, cwd, ts }`. Gitignored. |
| `.env` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Gitignored, never commit. |
| `.env.example` | Placeholder template. The only committed secrets file. |

---

## Prerequisites

- Node.js with `npx tsx` available
- A Telegram bot token from `@BotFather`
- A Telegram supergroup with Topics/Forum mode enabled
- The bot added as admin with **Manage Topics** + **Post Messages** permissions
- (Listener only) `claude` CLI on `$PATH` and `MY_ZAI_AUTH_TOKEN` set in the environment that starts `listener.ts`
- (Listener only) `/home/prei/bin/z-claude` executable wrapper — required because `z-claude` is a shell function and `spawnSync` cannot resolve shell functions; see README for the wrapper script

---

## Setup sequence

### 1. Create a Telegram bot

Message `@BotFather` → `/newbot` → follow prompts → copy the token.

### 2. Create the supergroup and enable Topics

1. Create a new Telegram group (must be a supergroup — promote it if needed)
2. Group settings → **Topics** → enable
3. Add your bot → promote to admin → enable **Manage Topics** and **Post Messages**

### 3. Get the group chat ID

Add `@userinfobot` to the group; it replies with the chat ID (a negative number like `-1001234567890`). Then remove it.

Alternatively: send a message in the group, then hit `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[*].message.chat.id`.

### 4. Configure secrets

```sh
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (the group's negative ID)
```

### 5. Install dependencies

```sh
npm install
```

### 6. Smoke test

```sh
echo '{"session_id":"test","cwd":"/home/user/myproject","hook_event_name":"Stop","last_assistant_message":"All done.","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

Expected: `{}` on stdout, no stderr errors, a message in the **myproject** topic of your group.

On first run for a new project name, `createForumTopic` is called and the result is written to `topics-cache.json`. Subsequent runs for the same project skip the API call.

### 7. Register hooks

Both `Stop` and `SessionStart` must run `notify.ts`. Stop sends the notification; SessionStart writes the pane ID immediately so the listener can route replies to the correct pane during an active session.

In `~/.claude/settings.json`:

```json
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
],
"SessionStart": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
]
```

### 8. (Optional) Run the listener

```sh
LISTENER_ENABLED=true npx tsx src/listener.ts
```

`MY_ZAI_AUTH_TOKEN` must be exported in the shell that runs this command. The listener blocks indefinitely — run it in a dedicated tmux window.

---

## Message format

```
📦 <project>  ·  📂 <cwd>
🌿 <branch>  ·  🪟 <tmux-window>  ·  🖥 <hostname>

❓ <last user instruction or /slash-command>

💬 <full last assistant message>
```

- `❓` line is omitted when no transcript is available or transcript is empty
- `❓` shows the `/command-name` for slash commands (extracted from `<command-name>` tags)
- `💬` contains the full `last_assistant_message` without truncation
- If the formatted message exceeds 4096 chars, it is split at the last newline before the limit; overflow chunks are sent as replies to the first message within the same topic thread

---

## Topic lifecycle

- Topics are created lazily on first notification for a project
- The mapping `{ "projectName": topicId }` is persisted in `topics-cache.json` at the repo root
- To force a new topic for a project, delete its entry from `topics-cache.json`
- To use a single fixed topic for all projects, manually set the desired `message_thread_id` — but this is not exposed as a config option; you'd modify `notify.ts` directly

---

## Failure modes

| Condition | Behaviour |
|---|---|
| `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing | Logs to stderr, exits 0 — never blocks Claude |
| Invalid stdin JSON | Logs to stderr, exits 0 |
| `createForumTopic` fails (e.g. bot lacks permission) | Logs to stderr, sends to general chat instead |
| Telegram `sendMessage` HTTP error | Logs to stderr, returns false — does not retry |
| Non-git directory | Branch field shows `n/a` |
| No tmux session | `🪟` field omitted from message |
| Transcript unreadable or missing | `❓` line omitted |
| `SessionStart` hook fires | Writes sessions-cache, skips Telegram send |
| `/home/prei/bin/z-claude` not found or exits non-zero | Replies "classifier unavailable" and blocks injection |
| `z-claude` returns `UNSAFE` | Replies "blocked: classifier flagged as unsafe" |
| Incoming message contains shell metacharacters | Blocked before classifier is called |

---

## Type check

```sh
npx tsc --noEmit
```

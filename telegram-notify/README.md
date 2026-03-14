# scripts

Telegram notification bot for Claude Code's `Stop` hook. Sends a message with project, branch, session, and last assistant message whenever Claude finishes a task.

## How it works

Claude Code fires the `Stop` hook when it finishes. The hook runs `notify.ts` via `npx tsx`, which reads the hook's stdin JSON, enriches it with git/hostname context, and POSTs to the Telegram Bot API. Failures are logged to stderr and never block Claude from stopping.

When `LISTENER_ENABLED=true`, a separate `listener.ts` process polls for incoming Telegram messages and injects them as keystrokes into the active tmux pane running Claude. `notify.ts` also registers on the `SessionStart` hook so the session cache always has the current pane ID before any reply arrives.

## Setup

### 1. Create a Telegram bot

Message `@BotFather` → `/newbot` → follow prompts → save the token.

### 2. Get your chat ID

Send any message to your bot, then:

```sh
curl https://api.telegram.org/bot<TOKEN>/getUpdates
```

Grab `result[0].message.chat.id`.

### 3. Configure secrets

```sh
cp .env.example .env
# Edit .env: fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

### 4. Install dependencies

```sh
npm install
```

### 5. Test

```sh
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"Stop","last_assistant_message":"done","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

Expect `{}` on stdout. With `.env` configured, a message should arrive in Telegram.

### 6. Register the hooks

Add to `~/.claude/settings.json` under `hooks`. Both `Stop` and `SessionStart` must run `notify.ts` — Stop sends the Telegram message, SessionStart writes the pane ID to sessions-cache so the listener can route replies correctly.

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

### 7. (Optional) Enable the two-way listener

The listener lets you reply to Telegram messages and have them injected into the active Claude pane.

```sh
# Add to .env
LISTENER_ENABLED=true
ALLOWED_USER_IDS=<your-telegram-user-id>
```

The classifier (`src/safe-inject.ts`) calls `z-claude` to check each incoming message before injecting. Because `z-claude` is a shell function, it must be wrapped as a real executable:

```sh
mkdir -p ~/bin
cat > ~/bin/z-claude <<'EOF'
#!/usr/bin/env bash
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
ANTHROPIC_AUTH_TOKEN="$MY_ZAI_AUTH_TOKEN" \
ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5" \
ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5" \
exec claude --model GLM-5 "$@"
EOF
chmod +x ~/bin/z-claude
```

`MY_ZAI_AUTH_TOKEN` must be set in the shell that starts `listener.ts` (not in `.env`). Start the listener manually:

```sh
npx tsx src/listener.ts
```

## Verification

```sh
# Type check
npx tsc --noEmit

# End-to-end with Telegram
echo '{"session_id":"abc","cwd":"'$(pwd)'","hook_event_name":"Stop","last_assistant_message":"All done.","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

## Edge cases

| Scenario | Behaviour |
|---|---|
| Missing env vars | Logs warning to stderr, exits 0 |
| Invalid stdin JSON | Logs warning to stderr, exits 0 |
| Non-git directory | Branch shows `n/a` |
| Message > 4096 chars | Split into reply chain within the same topic thread |
| Telegram API error | Logged to stderr, exits 0 |

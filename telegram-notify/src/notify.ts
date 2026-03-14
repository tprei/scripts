import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gatherContext } from "./context.js"
import { formatUserPrompt, formatAssistantReply } from "./format.js"
import { sendMessage } from "./telegram.js"
import { upsertSession, removeSession } from "./sessions.js"
import { getOrCreateTopic, deleteTopic, getProjectByThreadId, removeTopicFromCache } from "./topics.js"
import { extractLastInstruction } from "./transcript.js"
import { savePromptInfo, loadPromptInfo, clearPromptInfo } from "./prompt-cache.js"
import type { StopHookInput } from "./types.js"

const require = createRequire(import.meta.url)
const dotenv = require("dotenv")

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, "..", ".env") })

async function main() {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim()

    let input: StopHookInput
    try {
      input = JSON.parse(raw) as StopHookInput
    } catch {
      process.stderr.write(`notify: invalid JSON on stdin: ${raw.slice(0, 200)}\n`)
      process.stdout.write("{}\n")
      process.exit(0)
    }

    if (process.env["TELEGRAM_NOTIFY_DISABLED"]) {
      process.stdout.write("{}\n")
      process.exit(0)
    }

    const token = process.env["TELEGRAM_BOT_TOKEN"]
    const chatId = process.env["TELEGRAM_CHAT_ID"]

    if (!token || !chatId) {
      process.stderr.write("notify: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping\n")
      process.stdout.write("{}\n")
      process.exit(0)
    }

    const ctx = gatherContext(input.cwd)
    const threadId = await getOrCreateTopic(token, chatId, ctx.project)

    if (input.hook_event_name === "SessionEnd") {
      if (threadId !== null) {
        const deleted = await deleteTopic(token, chatId, threadId)
        if (deleted) {
          removeSession(threadId)
          const projectName = getProjectByThreadId(threadId)
          if (projectName) {
            removeTopicFromCache(projectName)
          }
        }
      }
      process.stdout.write("{}\n")
      process.exit(0)
      return
    }

    if (threadId !== null && process.env["LISTENER_ENABLED"]) {
      upsertSession(threadId, {
        session_id: input.session_id,
        pane_id: ctx.paneId,
        cwd: input.cwd,
        ts: Date.now(),
      })
    }

    if (input.hook_event_name === "UserPromptSubmit") {
      const message = formatUserPrompt(input, ctx)
      const result = await sendMessage(token, chatId, message, threadId ?? undefined)
      if (result.ok && result.messageId !== null) {
        savePromptInfo(input.session_id, result.messageId, Date.now())
      }
    } else if (input.hook_event_name === "Stop") {
      const cached = loadPromptInfo(input.session_id)
      const elapsedMs = cached ? Date.now() - cached.timestamp : undefined
      const replyToMessageId = cached?.messageId ?? undefined
      const lastInstruction = extractLastInstruction(input.transcript_path)
      const message = formatAssistantReply(input, ctx, lastInstruction, elapsedMs)
      await sendMessage(token, chatId, message, threadId ?? undefined, replyToMessageId)
      clearPromptInfo(input.session_id)
    }
  } catch (err) {
    process.stderr.write(`notify: unexpected error: ${err}\n`)
  }

  process.stdout.write("{}\n")
  process.exit(0)
}

main()

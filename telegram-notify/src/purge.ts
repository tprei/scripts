import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { purgeStaleTopics } from "./topics.js"
import { purgeStalePromptCache } from "./prompt-cache.js"
import { purgeStaleSessionCache } from "./sessions.js"

const require = createRequire(import.meta.url)
const dotenv = require("dotenv")

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, "..", ".env") })

const DEFAULT_TTL_HOURS = 4

function parseArgs(): { ttlMs: number; dryRun: boolean } {
  const args = process.argv.slice(2)
  let ttlHours = DEFAULT_TTL_HOURS
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ttl" && args[i + 1]) {
      ttlHours = Number(args[++i])
      if (isNaN(ttlHours) || ttlHours <= 0) {
        process.stderr.write(`purge: invalid --ttl value, using default ${DEFAULT_TTL_HOURS}h\n`)
        ttlHours = DEFAULT_TTL_HOURS
      }
    } else if (args[i] === "--dry-run") {
      dryRun = true
    }
  }

  return { ttlMs: ttlHours * 3600000, dryRun }
}

async function main() {
  const { ttlMs, dryRun } = parseArgs()
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const chatId = process.env["TELEGRAM_CHAT_ID"]

  if (!token || !chatId) {
    process.stderr.write("purge: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set\n")
    process.exit(1)
  }

  const ttlHours = ttlMs / 3600000
  process.stderr.write(`purge: TTL=${ttlHours}h${dryRun ? " (dry-run)" : ""}\n`)

  const topicResult = await purgeStaleTopics(token, chatId, ttlMs, { dryRun, delayMs: 100 })
  process.stderr.write(
    `purge: topics — legacy=${topicResult.legacy} stale=${topicResult.stale} failed=${topicResult.failed} skipped=${topicResult.skipped}\n`,
  )

  const promptRemoved = purgeStalePromptCache(ttlMs)
  process.stderr.write(`purge: prompt-cache — removed=${promptRemoved}\n`)

  const sessionRemoved = purgeStaleSessionCache(ttlMs)
  process.stderr.write(`purge: session-cache — removed=${sessionRemoved}\n`)
}

main().catch((err) => {
  process.stderr.write(`purge: unexpected error: ${err}\n`)
  process.exit(1)
})

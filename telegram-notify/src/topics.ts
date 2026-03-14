import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = path.resolve(scriptDir, "..", "topics-cache.json")

function readCache(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<string, number>
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, number>): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

export async function getOrCreateTopic(
  token: string,
  chatId: string,
  projectName: string,
): Promise<number | null> {
  const cache = readCache()
  if (cache[projectName] !== undefined) return cache[projectName]

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, name: projectName }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: createForumTopic HTTP ${res.status}: ${body}\n`)
      return null
    }

    const data = (await res.json()) as { ok: boolean; result: { message_thread_id: number } }
    const threadId = data.result.message_thread_id
    cache[projectName] = threadId
    writeCache(cache)
    return threadId
  } catch (err) {
    process.stderr.write(`telegram: createForumTopic failed: ${err}\n`)
    return null
  }
}

export function getProjectByThreadId(threadId: number): string | null {
  const cache = readCache()
  for (const [project, id] of Object.entries(cache)) {
    if (id === threadId) return project
  }
  return null
}

export function removeTopicFromCache(projectName: string): void {
  const cache = readCache()
  delete cache[projectName]
  writeCache(cache)
}

export async function deleteTopic(
  token: string,
  chatId: string,
  threadId: number,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId }),
    })

    if (!res.ok) {
      const body = await res.text()
      process.stderr.write(`telegram: deleteForumTopic HTTP ${res.status}: ${body}\n`)
      return false
    }

    const data = (await res.json()) as { ok: boolean }
    return data.ok === true
  } catch (err) {
    process.stderr.write(`telegram: deleteForumTopic failed: ${err}\n`)
    return false
  }
}

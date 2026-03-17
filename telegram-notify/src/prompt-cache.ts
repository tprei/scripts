import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = path.resolve(scriptDir, "..", "prompt-cache.json")

interface PromptInfo {
  messageId: number
  timestamp: number
  activityMessageId?: number
  activityTimestamp?: number
  toolCount?: number
}

type CacheData = Record<string, PromptInfo>

function readCache(): CacheData {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as CacheData
  } catch {
    return {}
  }
}

function writeCache(data: CacheData): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8")
}

export function savePromptInfo(sessionId: string, messageId: number, timestamp: number): void {
  const data = readCache()
  data[sessionId] = { messageId, timestamp }
  writeCache(data)
}

export function loadPromptInfo(sessionId: string): PromptInfo | null {
  const data = readCache()
  return data[sessionId] ?? null
}

export function clearPromptInfo(sessionId: string): void {
  const data = readCache()
  delete data[sessionId]
  writeCache(data)
}

export function incrementToolCount(sessionId: string): void {
  const data = readCache()
  if (!data[sessionId]) return
  data[sessionId].toolCount = (data[sessionId].toolCount ?? 0) + 1
  writeCache(data)
}

export function saveActivityInfo(
  sessionId: string,
  activityMessageId: number,
  timestamp: number,
  toolCount: number,
): void {
  const data = readCache()
  if (!data[sessionId]) return
  data[sessionId].activityMessageId = activityMessageId
  data[sessionId].activityTimestamp = timestamp
  data[sessionId].toolCount = toolCount
  writeCache(data)
}

export function loadActivityInfo(
  sessionId: string,
): { activityMessageId: number; activityTimestamp: number; toolCount: number } | null {
  const data = readCache()
  const entry = data[sessionId]
  if (
    !entry ||
    entry.activityMessageId === undefined ||
    entry.activityTimestamp === undefined ||
    entry.toolCount === undefined
  )
    return null
  return {
    activityMessageId: entry.activityMessageId,
    activityTimestamp: entry.activityTimestamp,
    toolCount: entry.toolCount,
  }
}

export function purgeStalePromptCache(ttlMs: number): number {
  const data = readCache()
  const now = Date.now()
  let removed = 0
  for (const key of Object.keys(data)) {
    if (now - data[key].timestamp > ttlMs) {
      delete data[key]
      removed++
    }
  }
  if (removed > 0) writeCache(data)
  return removed
}

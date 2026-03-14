import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = path.resolve(scriptDir, "..", "prompt-cache.json")

interface PromptInfo {
  messageId: number
  timestamp: number
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

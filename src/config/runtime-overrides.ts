import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { loggers } from "../logger.js"
import { captureException } from "../sentry.js"

const STORE_FILENAME = ".runtime-config.json"
const log = loggers.runtimeOverrides

export interface LoopOverride {
  enabled?: boolean
  intervalMs?: number
}

export interface RuntimeOverrides {
  loops?: Record<string, LoopOverride>
  workspace?: {
    maxConcurrentSessions?: number
  }
  loopsConfig?: {
    maxConcurrentLoops?: number
    reservedInteractiveSlots?: number
  }
  mcp?: {
    browserEnabled?: boolean
    githubEnabled?: boolean
    context7Enabled?: boolean
    sentryEnabled?: boolean
    supabaseEnabled?: boolean
    flyEnabled?: boolean
    zaiEnabled?: boolean
  }
  ci?: {
    babysitEnabled?: boolean
  }
  quota?: {
    retryMax?: number
    defaultSleepMs?: number
  }
}

export type OverrideFieldType = "number" | "boolean"
export type OverrideApply = "live" | "restart"
export type OverrideCategory = "loops" | "concurrency" | "features"

export interface OverrideField {
  key: string
  label: string
  type: OverrideFieldType
  category: OverrideCategory
  apply: OverrideApply
  min?: number
  max?: number
  integer?: boolean
  description?: string
}

export interface LoopMeta {
  id: string
  name: string
  defaultIntervalMs: number
  defaultEnabled: boolean
}

export interface RuntimeOverridesSchema {
  fields: OverrideField[]
  loops: LoopMeta[]
}

export type OverridesChangeListener = (next: RuntimeOverrides, previous: RuntimeOverrides) => void

export class RuntimeOverridesStore {
  private readonly filePath: string
  private current: RuntimeOverrides = {}
  private readonly emitter = new EventEmitter()
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
  }

  async load(): Promise<RuntimeOverrides> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as unknown
      this.current = sanitize(parsed)
      log.info({ keys: Object.keys(this.current) }, "runtime overrides loaded")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err, path: this.filePath }, "failed to load runtime overrides, starting empty")
        captureException(err, { operation: "runtime-overrides.load" })
      }
      this.current = {}
    }
    return this.current
  }

  get(): RuntimeOverrides {
    return clone(this.current)
  }

  on(event: "changed", listener: OverridesChangeListener): () => void {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }

  async patch(partial: RuntimeOverrides, loopIds: ReadonlySet<string>): Promise<RuntimeOverrides> {
    const validationErr = validatePatch(partial, loopIds)
    if (validationErr) {
      throw new RuntimeOverrideValidationError(validationErr)
    }
    const previous = clone(this.current)
    const next = mergeOverrides(this.current, partial)
    this.current = next
    this.saveQueue = this.saveQueue.then(() => this.write(next), () => this.write(next))
    await this.saveQueue
    this.emitter.emit("changed", clone(next), previous)
    return clone(next)
  }

  async reset(): Promise<void> {
    const previous = clone(this.current)
    this.current = {}
    this.saveQueue = this.saveQueue.then(
      () => this.write({}),
      () => this.write({}),
    )
    await this.saveQueue
    this.emitter.emit("changed", {}, previous)
  }

  private async write(data: RuntimeOverrides): Promise<void> {
    const tmp = this.filePath + ".tmp"
    try {
      await fs.mkdir(path.dirname(tmp), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
      await fs.rename(tmp, this.filePath)
    } catch (err) {
      log.error({ err, path: this.filePath }, "failed to write runtime overrides")
      captureException(err, { operation: "runtime-overrides.write" })
      throw err
    }
  }
}

export class RuntimeOverrideValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeOverrideValidationError"
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function sanitize(parsed: unknown): RuntimeOverrides {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed as RuntimeOverrides
}

function mergeOverrides(base: RuntimeOverrides, patch: RuntimeOverrides): RuntimeOverrides {
  const next: RuntimeOverrides = clone(base)

  if (patch.loops) {
    next.loops = { ...(next.loops ?? {}) }
    for (const [id, override] of Object.entries(patch.loops)) {
      const existing = next.loops[id] ?? {}
      next.loops[id] = { ...existing, ...override }
    }
  }
  if (patch.workspace) {
    next.workspace = { ...(next.workspace ?? {}), ...patch.workspace }
  }
  if (patch.loopsConfig) {
    next.loopsConfig = { ...(next.loopsConfig ?? {}), ...patch.loopsConfig }
  }
  if (patch.mcp) {
    next.mcp = { ...(next.mcp ?? {}), ...patch.mcp }
  }
  if (patch.ci) {
    next.ci = { ...(next.ci ?? {}), ...patch.ci }
  }
  if (patch.quota) {
    next.quota = { ...(next.quota ?? {}), ...patch.quota }
  }
  return next
}

function validatePatch(patch: RuntimeOverrides, loopIds: ReadonlySet<string>): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return "patch must be an object"
  }

  if (patch.loops) {
    if (typeof patch.loops !== "object" || Array.isArray(patch.loops)) {
      return "loops must be an object keyed by loop id"
    }
    for (const [id, override] of Object.entries(patch.loops)) {
      if (!loopIds.has(id)) return `unknown loop id: ${id}`
      if (!override || typeof override !== "object" || Array.isArray(override)) {
        return `loops.${id} must be an object`
      }
      if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
        return `loops.${id}.enabled must be boolean`
      }
      if (override.intervalMs !== undefined) {
        const err = validateIntRange(override.intervalMs, `loops.${id}.intervalMs`, 60_000, 7 * 24 * 60 * 60 * 1000)
        if (err) return err
      }
    }
  }

  if (patch.workspace?.maxConcurrentSessions !== undefined) {
    const err = validateIntRange(patch.workspace.maxConcurrentSessions, "workspace.maxConcurrentSessions", 1, 100)
    if (err) return err
  }
  if (patch.loopsConfig?.maxConcurrentLoops !== undefined) {
    const err = validateIntRange(patch.loopsConfig.maxConcurrentLoops, "loopsConfig.maxConcurrentLoops", 1, 50)
    if (err) return err
  }
  if (patch.loopsConfig?.reservedInteractiveSlots !== undefined) {
    const err = validateIntRange(patch.loopsConfig.reservedInteractiveSlots, "loopsConfig.reservedInteractiveSlots", 0, 50)
    if (err) return err
  }
  if (patch.mcp) {
    for (const [k, v] of Object.entries(patch.mcp)) {
      if (v !== undefined && typeof v !== "boolean") {
        return `mcp.${k} must be boolean`
      }
    }
  }
  if (patch.ci?.babysitEnabled !== undefined && typeof patch.ci.babysitEnabled !== "boolean") {
    return "ci.babysitEnabled must be boolean"
  }
  if (patch.quota?.retryMax !== undefined) {
    const err = validateIntRange(patch.quota.retryMax, "quota.retryMax", 0, 20)
    if (err) return err
  }
  if (patch.quota?.defaultSleepMs !== undefined) {
    const err = validateIntRange(patch.quota.defaultSleepMs, "quota.defaultSleepMs", 1_000, 24 * 60 * 60 * 1000)
    if (err) return err
  }
  return null
}

function validateIntRange(value: unknown, key: string, min: number, max: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return `${key} must be an integer`
  }
  if (value < min) return `${key} must be >= ${min}`
  if (value > max) return `${key} must be <= ${max}`
  return null
}

export function buildSchema(loops: LoopMeta[]): RuntimeOverridesSchema {
  const fields: OverrideField[] = []

  for (const loop of loops) {
    fields.push({
      key: `loops.${loop.id}.enabled`,
      label: `${loop.name} — enabled`,
      type: "boolean",
      category: "loops",
      apply: "live",
    })
    fields.push({
      key: `loops.${loop.id}.intervalMs`,
      label: `${loop.name} — interval (ms)`,
      type: "number",
      category: "loops",
      apply: "live",
      min: 60_000,
      max: 7 * 24 * 60 * 60 * 1000,
      integer: true,
      description: "Time between loop runs in milliseconds",
    })
  }

  fields.push({
    key: "workspace.maxConcurrentSessions",
    label: "Max concurrent sessions",
    type: "number",
    category: "concurrency",
    apply: "live",
    min: 1,
    max: 100,
    integer: true,
  })
  fields.push({
    key: "loopsConfig.maxConcurrentLoops",
    label: "Max concurrent loops",
    type: "number",
    category: "concurrency",
    apply: "live",
    min: 1,
    max: 50,
    integer: true,
  })
  fields.push({
    key: "loopsConfig.reservedInteractiveSlots",
    label: "Reserved interactive slots",
    type: "number",
    category: "concurrency",
    apply: "live",
    min: 0,
    max: 50,
    integer: true,
  })
  fields.push({
    key: "quota.retryMax",
    label: "Quota retry max",
    type: "number",
    category: "concurrency",
    apply: "live",
    min: 0,
    max: 20,
    integer: true,
  })
  fields.push({
    key: "quota.defaultSleepMs",
    label: "Quota default sleep (ms)",
    type: "number",
    category: "concurrency",
    apply: "live",
    min: 1_000,
    max: 24 * 60 * 60 * 1000,
    integer: true,
  })

  fields.push({
    key: "ci.babysitEnabled",
    label: "CI babysitter",
    type: "boolean",
    category: "features",
    apply: "restart",
    description: "Watch CI on opened PRs and spawn ci-fix sessions on failures",
  })
  for (const [flag, label] of [
    ["browserEnabled", "Playwright (browser)"],
    ["githubEnabled", "GitHub MCP"],
    ["context7Enabled", "Context7 MCP"],
    ["sentryEnabled", "Sentry MCP"],
    ["supabaseEnabled", "Supabase MCP"],
    ["flyEnabled", "Fly.io MCP"],
    ["zaiEnabled", "Z.AI web search"],
  ] as const) {
    fields.push({
      key: `mcp.${flag}`,
      label,
      type: "boolean",
      category: "features",
      apply: "restart",
    })
  }

  return { fields, loops }
}

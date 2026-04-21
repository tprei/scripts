import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  RuntimeOverridesStore,
  RuntimeOverrideValidationError,
  buildSchema,
} from "../../src/config/runtime-overrides.js"

const LOOP_IDS = new Set(["alpha", "beta"])

describe("RuntimeOverridesStore", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-overrides-"))
  })

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it("loads empty when file missing", async () => {
    const store = new RuntimeOverridesStore(workspace)
    const loaded = await store.load()
    expect(loaded).toEqual({})
  })

  it("persists and reloads a valid patch", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const next = await store.patch(
      {
        loops: { alpha: { enabled: false, intervalMs: 120_000 } },
        workspace: { maxConcurrentSessions: 8 },
      },
      LOOP_IDS,
    )
    expect(next.loops?.alpha).toEqual({ enabled: false, intervalMs: 120_000 })
    expect(next.workspace?.maxConcurrentSessions).toBe(8)

    const second = new RuntimeOverridesStore(workspace)
    const loaded = await second.load()
    expect(loaded.loops?.alpha).toEqual({ enabled: false, intervalMs: 120_000 })
    expect(loaded.workspace?.maxConcurrentSessions).toBe(8)
  })

  it("merges patches rather than replacing", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    await store.patch({ loops: { alpha: { intervalMs: 120_000 } } }, LOOP_IDS)
    const merged = await store.patch({ loops: { alpha: { enabled: false } } }, LOOP_IDS)
    expect(merged.loops?.alpha).toEqual({ enabled: false, intervalMs: 120_000 })
  })

  it("rejects unknown loop ids", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    await expect(
      store.patch({ loops: { ghost: { enabled: true } } }, LOOP_IDS),
    ).rejects.toBeInstanceOf(RuntimeOverrideValidationError)
  })

  it("rejects out-of-range integers", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    await expect(
      store.patch({ workspace: { maxConcurrentSessions: 0 } }, LOOP_IDS),
    ).rejects.toBeInstanceOf(RuntimeOverrideValidationError)
    await expect(
      store.patch({ loops: { alpha: { intervalMs: 1 } } }, LOOP_IDS),
    ).rejects.toBeInstanceOf(RuntimeOverrideValidationError)
  })

  it("rejects wrong types", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    await expect(
      store.patch(
        { ci: { babysitEnabled: "yes" as unknown as boolean } },
        LOOP_IDS,
      ),
    ).rejects.toBeInstanceOf(RuntimeOverrideValidationError)
  })

  it("emits change events with previous and next state", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const events: Array<{ next: unknown; previous: unknown }> = []
    store.on("changed", (next, previous) => events.push({ next, previous }))
    await store.patch({ workspace: { maxConcurrentSessions: 4 } }, LOOP_IDS)
    await store.patch({ workspace: { maxConcurrentSessions: 6 } }, LOOP_IDS)
    expect(events).toHaveLength(2)
    expect(events[1].previous).toEqual({ workspace: { maxConcurrentSessions: 4 } })
    expect(events[1].next).toEqual({ workspace: { maxConcurrentSessions: 6 } })
  })
})

describe("buildSchema", () => {
  it("produces fields for each loop + global knobs", () => {
    const schema = buildSchema([
      { id: "alpha", name: "Alpha", defaultEnabled: true, defaultIntervalMs: 120_000 },
    ])
    const keys = schema.fields.map((f) => f.key)
    expect(keys).toContain("loops.alpha.enabled")
    expect(keys).toContain("loops.alpha.intervalMs")
    expect(keys).toContain("workspace.maxConcurrentSessions")
    expect(keys).toContain("ci.babysitEnabled")
    const restartField = schema.fields.find((f) => f.key === "ci.babysitEnabled")
    expect(restartField?.apply).toBe("restart")
  })
})

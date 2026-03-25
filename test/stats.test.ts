import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { StatsTracker, type SessionRecord } from "../src/stats.js"

describe("StatsTracker", () => {
  let tmpDir: string
  let tracker: StatsTracker

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"))
    tracker = new StatsTracker(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeRecord(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      slug: "bold-arc",
      repo: "test-repo",
      mode: "task",
      state: "completed",
      durationMs: 60000,
      totalTokens: 5000,
            timestamp: Date.now(),
      ...overrides,
    }
  }

  it("records and loads entries", async () => {
    await tracker.record(makeRecord())
    await tracker.record(makeRecord({ slug: "calm-bay" }))
    const loaded = await tracker.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].slug).toBe("bold-arc")
    expect(loaded[1].slug).toBe("calm-bay")
  })

  it("returns empty array when no file exists", async () => {
    expect(await tracker.load()).toEqual([])
  })

  it("aggregates stats correctly", async () => {
    await tracker.record(makeRecord({ durationMs: 30000, totalTokens: 1000 }))
    await tracker.record(makeRecord({ durationMs: 90000, totalTokens: 3000, state: "errored" }))

    const agg = await tracker.aggregate()
    expect(agg.totalSessions).toBe(2)
    expect(agg.completedSessions).toBe(1)
    expect(agg.erroredSessions).toBe(1)
    expect(agg.totalTokens).toBe(4000)
    expect(agg.totalDurationMs).toBe(120000)
    expect(agg.avgDurationMs).toBe(60000)
  })

  it("filters by days when aggregating", async () => {
    const old = Date.now() - 10 * 86400000
    await tracker.record(makeRecord({ timestamp: old }))
    await tracker.record(makeRecord({ timestamp: Date.now() }))

    const agg = await tracker.aggregate(7)
    expect(agg.totalSessions).toBe(1)
  })

  it("caps at MAX_RECORDS", { timeout: 30000 }, async () => {
    // Seed 509 records directly to avoid 1000+ file I/O round-trips
    const seed = Array.from({ length: 509 }, (_, i) => makeRecord({ slug: `slug-${i}` }))
    fs.writeFileSync(path.join(tmpDir, ".stats.json"), JSON.stringify(seed))

    // One more record() call triggers the cap logic
    await tracker.record(makeRecord({ slug: "slug-509" }))
    const loaded = await tracker.load()
    expect(loaded.length).toBeLessThanOrEqual(500)
    expect(loaded[loaded.length - 1].slug).toBe("slug-509")
  })

  describe("recentSessions", () => {
    it("returns most recent N sessions in reverse order", async () => {
      await tracker.record(makeRecord({ slug: "first" }))
      await tracker.record(makeRecord({ slug: "second" }))
      await tracker.record(makeRecord({ slug: "third" }))

      const recent = await tracker.recentSessions(2)
      expect(recent).toHaveLength(2)
      expect(recent[0].slug).toBe("third")
      expect(recent[1].slug).toBe("second")
    })

    it("returns all sessions when N exceeds count", async () => {
      await tracker.record(makeRecord({ slug: "only" }))
      const recent = await tracker.recentSessions(5)
      expect(recent).toHaveLength(1)
      expect(recent[0].slug).toBe("only")
    })

    it("returns empty array when no sessions", async () => {
      expect(await tracker.recentSessions(5)).toEqual([])
    })
  })

  describe("breakdownByMode", () => {
    it("groups sessions by mode", async () => {
      await tracker.record(makeRecord({ mode: "task", totalTokens: 1000 }))
      await tracker.record(makeRecord({ mode: "task", totalTokens: 2000 }))
      await tracker.record(makeRecord({ mode: "plan", totalTokens: 500 }))

      const breakdown = await tracker.breakdownByMode()
      expect(breakdown.task).toEqual({ count: 2, tokens: 3000, durationMs: 120000 })
      expect(breakdown.plan).toEqual({ count: 1, tokens: 500, durationMs: 60000 })
    })

    it("filters by time window", async () => {
      const old = Date.now() - 10 * 86400000
      await tracker.record(makeRecord({ mode: "task", timestamp: old }))
      await tracker.record(makeRecord({ mode: "task", timestamp: Date.now() }))

      const breakdown = await tracker.breakdownByMode(7)
      expect(breakdown.task.count).toBe(1)
    })

    it("returns empty object when no sessions", async () => {
      expect(await tracker.breakdownByMode()).toEqual({})
    })
  })
})

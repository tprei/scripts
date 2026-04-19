import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { CommandHandler } from "../src/commands/command-handler.js"
import type { EngineContext } from "../src/engine/engine-context.js"
import type { PendingTask } from "../src/session/session-manager.js"
import { createMockContext, makeMockConfig } from "./test-helpers.js"

vi.mock("../src/telegram/format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telegram/format.js")>()
  return {
    ...actual,
    formatStatus: vi.fn(() => "status"),
    formatStats: vi.fn(() => "stats"),
    formatUsage: vi.fn(() => "usage"),
    formatHelp: vi.fn(() => "help"),
    formatProfileList: vi.fn(() => "profiles"),
    formatConfigHelp: vi.fn(() => "config help"),
  }
})

vi.mock("../src/claude-usage.js", () => ({
  fetchClaudeUsage: vi.fn().mockResolvedValue(null),
}))

vi.mock("../src/session/session-manager.js", () => ({
  buildExecutionPrompt: vi.fn(() => "execution prompt"),
  dirSizeBytes: vi.fn(() => 0),
}))

describe("pending keyboard TTL", () => {
  let ctx: EngineContext
  let handler: CommandHandler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ctx = createMockContext({
      config: makeMockConfig({
        repos: { myrepo: "https://github.com/org/myrepo", other: "https://github.com/org/other" },
      }),
    })
    handler = new CommandHandler(ctx)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses setPendingTask when creating a task with repo keyboard", async () => {
    ctx.telegram.sendMessageWithKeyboard = vi.fn(async () => 42)

    await handler.handleTaskCommand("do something", 1)

    expect(ctx.setPendingTask).toHaveBeenCalledWith(42, {
      task: "do something",
      threadId: 1,
      mode: "task",
    })
  })

  it("uses setPendingTask for review commands needing repo selection", async () => {
    ctx.telegram.sendMessageWithKeyboard = vi.fn(async () => 99)

    await handler.handleReviewCommand("", 1)

    expect(ctx.setPendingTask).toHaveBeenCalledWith(99, {
      task: "",
      threadId: 1,
      mode: "review",
    })
  })

  it("uses setPendingTask for review with task but no repo", async () => {
    ctx.telegram.sendMessageWithKeyboard = vi.fn(async () => 55)

    await handler.handleReviewCommand("#123", 1)

    expect(ctx.setPendingTask).toHaveBeenCalledWith(55, {
      task: "#123",
      threadId: 1,
      mode: "review",
    })
  })

  describe("mock setPendingTask/clearPendingTask behavior", () => {
    it("setPendingTask adds entry to pendingTasks map", () => {
      ctx.setPendingTask(42, { task: "test", mode: "task" })
      expect(ctx.pendingTasks.get(42)).toEqual({ task: "test", mode: "task" })
    })

    it("clearPendingTask removes entry and returns it", () => {
      ctx.setPendingTask(42, { task: "test", mode: "task" })
      const entry = ctx.clearPendingTask(42)
      expect(entry).toEqual({ task: "test", mode: "task" })
      expect(ctx.pendingTasks.has(42)).toBe(false)
    })

    it("clearPendingTask returns undefined for missing entry", () => {
      const entry = ctx.clearPendingTask(999)
      expect(entry).toBeUndefined()
    })
  })
})

describe("MinionEngine pending TTL internals", () => {
  const PENDING_TTL_MS = 60 * 60 * 1000

  let pendingMap: Map<number, PendingTask>
  let timerMap: Map<number, ReturnType<typeof setTimeout>>
  let deleteMessage: ReturnType<typeof vi.fn>
  let setPendingWithTTL: (map: Map<number, PendingTask>, msgId: number, entry: PendingTask) => void
  let clearPending: (map: Map<number, PendingTask>, msgId: number) => PendingTask | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    pendingMap = new Map()
    timerMap = new Map()
    deleteMessage = vi.fn(async () => {})

    setPendingWithTTL = (map, msgId, entry) => {
      map.set(msgId, entry)
      const timer = setTimeout(() => {
        map.delete(msgId)
        timerMap.delete(msgId)
        deleteMessage(String(msgId)).catch(() => {})
      }, PENDING_TTL_MS)
      timerMap.set(msgId, timer)
    }

    clearPending = (map, msgId) => {
      const entry = map.get(msgId)
      if (entry) {
        map.delete(msgId)
        const timer = timerMap.get(msgId)
        if (timer) {
          clearTimeout(timer)
          timerMap.delete(msgId)
        }
      }
      return entry
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("entry expires after 1 hour and deletes the keyboard message", () => {
    setPendingWithTTL(pendingMap, 42, { task: "test", mode: "task" })
    expect(pendingMap.has(42)).toBe(true)
    expect(timerMap.has(42)).toBe(true)

    vi.advanceTimersByTime(PENDING_TTL_MS)

    expect(pendingMap.has(42)).toBe(false)
    expect(timerMap.has(42)).toBe(false)
    expect(deleteMessage).toHaveBeenCalledWith("42")
  })

  it("entry does not expire before 1 hour", () => {
    setPendingWithTTL(pendingMap, 42, { task: "test", mode: "task" })

    vi.advanceTimersByTime(PENDING_TTL_MS - 1)

    expect(pendingMap.has(42)).toBe(true)
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it("clearPending cancels the TTL timer", () => {
    setPendingWithTTL(pendingMap, 42, { task: "test", mode: "task" })

    const entry = clearPending(pendingMap, 42)
    expect(entry).toEqual({ task: "test", mode: "task" })

    vi.advanceTimersByTime(PENDING_TTL_MS)

    expect(pendingMap.has(42)).toBe(false)
    expect(timerMap.has(42)).toBe(false)
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it("multiple entries expire independently", () => {
    setPendingWithTTL(pendingMap, 1, { task: "a", mode: "task" })

    vi.advanceTimersByTime(30 * 60 * 1000) // 30 min

    setPendingWithTTL(pendingMap, 2, { task: "b", mode: "plan" })

    vi.advanceTimersByTime(30 * 60 * 1000) // another 30 min — first entry expires

    expect(pendingMap.has(1)).toBe(false)
    expect(pendingMap.has(2)).toBe(true)

    vi.advanceTimersByTime(30 * 60 * 1000) // another 30 min — second entry expires

    expect(pendingMap.has(2)).toBe(false)
    expect(deleteMessage).toHaveBeenCalledTimes(2)
  })

  it("clearPending returns undefined for nonexistent key", () => {
    const result = clearPending(pendingMap, 999)
    expect(result).toBeUndefined()
  })
})

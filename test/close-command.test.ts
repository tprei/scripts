import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import { loggers } from "../src/logger.js"
import { EventBus } from "../src/events/event-bus.js"

const WORKSPACE_ROOT = "/tmp/test-workspace-close-command"
const SESSIONS_FILE = path.join(WORKSPACE_ROOT, ".sessions.json")

function makeMockPlatform(): ChatPlatform {
  return {
    name: "telegram",
    chatId: "123",
    chat: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "1" }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      pinMessage: vi.fn().mockResolvedValue(undefined),
    },
    threads: {
      createThread: vi.fn().mockResolvedValue({ threadId: "42", name: "test" }),
      editThread: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    },
    input: {
      poll: vi.fn().mockResolvedValue([]),
      getCursor: vi.fn().mockReturnValue("0"),
      advanceCursor: vi.fn(),
    },
    ui: {
      sendMessageWithKeyboard: vi.fn().mockResolvedValue("1"),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      sendPhoto: vi.fn().mockResolvedValue("1"),
      sendPhotoBuffer: vi.fn().mockResolvedValue("1"),
      downloadFile: vi.fn().mockResolvedValue(true),
    },
    formatter: null,
    threadLink: vi.fn().mockReturnValue(undefined),
  } as unknown as ChatPlatform
}

async function clearSessionsFile() {
  try {
    await fs.unlink(SESSIONS_FILE)
  } catch {
    // File doesn't exist, that's fine
  }
}

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: "123", allowedUserIds: [1] },
    telegramQueue: { minSendIntervalMs: 0 },
    workspace: {
      root: WORKSPACE_ROOT,
      maxConcurrentSessions: 2,
      maxDagConcurrency: 3,
      maxSplitItems: 10,
      sessionTokenBudget: 100000,
      sessionBudgetUsd: 10,
      sessionTimeoutMs: 60_000,
      sessionInactivityTimeoutMs: 60_000,
      staleTtlMs: 86_400_000,
      cleanupIntervalMs: 3600000,
      maxConversationLength: 50,
    },
    repos: {},
    ci: {
      babysitEnabled: false,
      maxRetries: 0,
      pollIntervalMs: 5000,
      pollTimeoutMs: 300000,
      dagCiPolicy: "skip",
    },
    mcp: {
      browserEnabled: false,
      githubEnabled: false,
      context7Enabled: false,
      sentryEnabled: false,
      sentryOrgSlug: "",
      sentryProjectSlug: "",
      supabaseEnabled: false,
      supabaseProjectRef: "",
      flyEnabled: false,
      flyOrg: "",
      zaiEnabled: false,
    },
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
  } as MinionConfig
}

// Ensure workspace directory exists and sessions file is cleared before each test
beforeEach(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
  await clearSessionsFile()
})

describe("handleCloseCommand ordering", () => {
  it("deletes topic before starting workspace cleanup", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const callOrder: string[] = []
    // Track call order
    const origDelete = platform.threads.deleteThread as ReturnType<typeof vi.fn>
    origDelete.mockImplementation(async () => {
      callOrder.push("deleteThread")
      return true
    })
    // Inject a topic session
    const topicSession: TopicSession = {
      threadId: "100",
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("100", topicSession)
    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand("100")
    expect(callOrder).toContain("deleteThread")
    expect(origDelete).toHaveBeenCalledWith("100")
    // Topic session should be removed from the map
    expect(topicSessions.has("100")).toBe(false)
  })
  it("deletes topic before killing active session process", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const callOrder: string[] = []
    ;(platform.threads.deleteThread as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("deleteThread")
      return true
    })
    const mockKill = vi.fn().mockImplementation(async () => {
      callOrder.push("kill")
      // Simulate slow kill
      await new Promise((r) => setTimeout(r, 50))
    })
    const topicSession: TopicSession = {
      threadId: "200",
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-id",
    }
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("200", topicSession)
    const sessions = (dispatcher as unknown as { sessions: Map<string, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set("200", {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })
    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand("200")
    // deleteThread must have been called BEFORE kill
    expect(callOrder[0]).toBe("deleteThread")
    // kill happens in background, give it time to complete
    await new Promise((r) => setTimeout(r, 100))
    expect(callOrder).toContain("kill")
  })
})
describe("closeChildSessions warning for high child count", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(loggers.dispatcher, "warn").mockImplementation(() => loggers.dispatcher)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })
  it("logs warning when closing more than 10 children", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: "1000",
      repo: "test-repo",
      cwd: "/tmp/workspace",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set("1000", parentSession)
    // Create 15 child sessions (exceeds threshold of 10)
    for (let i = 0; i < 15; i++) {
      const childSession: TopicSession = {
        threadId: String(2000 + i),
        repo: "test-repo",
        cwd: `/tmp/workspace-child-${i}`,
        slug: `child-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: "1000",
      }
      topicSessions.set(String(2000 + i), childSession)
      parentSession.childThreadIds!.push(String(2000 + i))
    }
    await dispatcher.handleCloseCommand("1000")
    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 15,
        parentThreadId: "1000",
        parentSlug: "parent-slug",
      }),
      "Unusually high number of children to close - possible bug?"
    )
  })
  it("does not log warning when closing 10 or fewer children", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: "3000",
      repo: "test-repo",
      cwd: "/tmp/workspace",
      slug: "parent-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set("3000", parentSession)
    // Create exactly 10 child sessions (at threshold, should NOT warn)
    for (let i = 0; i < 10; i++) {
      const childSession: TopicSession = {
        threadId: String(4000 + i),
        repo: "test-repo",
        cwd: `/tmp/workspace-child-${i}`,
        slug: `child-slug-threshold-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: "3000",
      }
      topicSessions.set(String(4000 + i), childSession)
      parentSession.childThreadIds!.push(String(4000 + i))
    }
    await dispatcher.handleCloseCommand("3000")
    // Verify warning was NOT logged
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
describe("closeChildSessions orphan detection", () => {
  it("only closes actual children, not unrelated sessions", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: "5000",
      repo: "test-repo",
      cwd: "/tmp/workspace-parent",
      slug: "parent-slug-orphan-test",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [],
    }
    topicSessions.set("5000", parentSession)
    // Create multiple UNRELATED sessions (no parentThreadId set)
    for (let i = 0; i < 5; i++) {
      const unrelated: TopicSession = {
        threadId: String(6000 + i),
        repo: "other-repo",
        cwd: `/tmp/workspace-unrelated-${i}`,
        slug: `unrelated-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        // Note: parentThreadId is undefined (not set)
      }
      topicSessions.set(String(6000 + i), unrelated)
    }
    // Create more unrelated sessions with a DIFFERENT parentThreadId
    const otherParentId = "9999"
    for (let i = 0; i < 3; i++) {
      const otherChild: TopicSession = {
        threadId: String(7000 + i),
        repo: "other-repo-2",
        cwd: `/tmp/workspace-other-child-${i}`,
        slug: `other-child-slug-${i}`,
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
        parentThreadId: otherParentId, // Different parent
      }
      topicSessions.set(String(7000 + i), otherChild)
    }
    // Create ONE actual child of the parent
    const actualChild: TopicSession = {
      threadId: "8000",
      repo: "test-repo",
      cwd: "/tmp/workspace-actual-child",
      slug: "actual-child-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      parentThreadId: "5000", // Points to our parent
    }
    topicSessions.set("8000", actualChild)
    parentSession.childThreadIds!.push("8000")
    // Verify setup: should have 10 sessions total (parent + 5 unrelated + 3 other children + 1 actual child)
    const expectedCount = 1 + 5 + 3 + 1
    expect(topicSessions.size).toBe(expectedCount)
    // Close the parent
    await dispatcher.handleCloseCommand("5000")
    // CRITICAL: Only the actual child (threadId 8000) should be deleted, NOT all sessions
    // The parent (5000) should also be deleted
    expect(topicSessions.has("5000")).toBe(false) // Parent deleted
    expect(topicSessions.has("8000")).toBe(false) // Actual child deleted
    // All unrelated sessions should STILL EXIST
    for (let i = 0; i < 5; i++) {
      expect(topicSessions.has(String(6000 + i))).toBe(true)
    }
    for (let i = 0; i < 3; i++) {
      expect(topicSessions.has(String(7000 + i))).toBe(true)
    }
    // Should have 8 sessions remaining (5 + 3 unrelated)
    expect(topicSessions.size).toBe(8)
    // Verify deleteThread was called only for parent and actual child
    const deleteCalls = (platform.threads.deleteThread as ReturnType<typeof vi.fn>).mock.calls
    const deletedThreadIds = deleteCalls.map((call: unknown[]) => call[0])
    expect(deletedThreadIds).toContain("5000") // Parent
    expect(deletedThreadIds).toContain("8000") // Actual child
    expect(deletedThreadIds).not.toContain("6000") // Unrelated
    expect(deletedThreadIds).not.toContain("6001") // Unrelated
    expect(deletedThreadIds).not.toContain("7000") // Other parent's child
  })
  it("handles orphaned children not in childThreadIds array", async () => {
    const platform = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(platform.chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    // Create parent session
    const parentSession: TopicSession = {
      threadId: "5100",
      repo: "test-repo",
      cwd: "/tmp/workspace-parent-orphan",
      slug: "parent-orphan-test",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      childThreadIds: [], // Empty - child is not tracked here
    }
    topicSessions.set("5100", parentSession)
    // Create an orphaned child (parentThreadId points to parent, but not in childThreadIds)
    const orphanedChild: TopicSession = {
      threadId: "8100",
      repo: "test-repo",
      cwd: "/tmp/workspace-orphan-child",
      slug: "orphan-child-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      parentThreadId: "5100", // Points to parent, but parent.childThreadIds is empty
    }
    topicSessions.set("8100", orphanedChild)
    // Create an unrelated session
    const unrelated: TopicSession = {
      threadId: "9100",
      repo: "other-repo",
      cwd: "/tmp/workspace-unrelated-orphan",
      slug: "unrelated-orphan-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set("9100", unrelated)
    expect(topicSessions.size).toBe(3)
    // Close the parent
    await dispatcher.handleCloseCommand("5100")
    // Parent and orphaned child should be deleted
    expect(topicSessions.has("5100")).toBe(false)
    expect(topicSessions.has("8100")).toBe(false)
    // Unrelated session should remain
    expect(topicSessions.has("9100")).toBe(true)
    expect(topicSessions.size).toBe(1)
  })
})

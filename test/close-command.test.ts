import { describe, it, expect, vi, beforeEach } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import type { TopicSession } from "../src/types.js"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "supergroup" } }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    pinMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as unknown as TelegramClient
}

function makeConfig(): MinionConfig {
  return {
    telegram: { token: "test", chatId: 1, allowedUserIds: [1] },
    workspace: {
      root: "/tmp/test-workspace",
      maxConcurrentSessions: 2,
      sessionTimeoutMs: 60_000,
      staleTtlMs: 86_400_000,
    },
    repos: {},
    session: {
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test" },
      mcp: {
        browserEnabled: false,
        githubEnabled: false,
        context7Enabled: false,
        sentryEnabled: false,
        sentryOrgSlug: "",
        sentryProjectSlug: "",
        zaiEnabled: false,
      },
    },
    ci: {
      enabled: false,
      babysitMaxRetries: 0,
      qualityGatesEnabled: false,
    },
  } as MinionConfig
}

describe("handleCloseCommand ordering", () => {
  it("deletes topic before starting workspace cleanup", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const callOrder: string[] = []

    // Track call order
    const origDelete = telegram.deleteForumTopic as ReturnType<typeof vi.fn>
    origDelete.mockImplementation(async () => {
      callOrder.push("deleteForumTopic")
      return true
    })

    // Inject a topic session
    const topicSession: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(100, topicSession)

    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand(100)

    expect(callOrder).toContain("deleteForumTopic")
    expect(origDelete).toHaveBeenCalledWith(100)
    // Topic session should be removed from the map
    expect(topicSessions.has(100)).toBe(false)
  })

  it("deletes topic before killing active session process", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const callOrder: string[] = []

    ;(telegram.deleteForumTopic as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("deleteForumTopic")
      return true
    })

    const mockKill = vi.fn().mockImplementation(async () => {
      callOrder.push("kill")
      // Simulate slow kill
      await new Promise((r) => setTimeout(r, 50))
    })

    const topicSession: TopicSession = {
      threadId: 200,
      repo: "test-repo",
      cwd: "/tmp/nonexistent-workspace",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-id",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(200, topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<number, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set(200, {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Call handleCloseCommand with threadId (public API)
    await dispatcher.handleCloseCommand(200)

    // deleteForumTopic must have been called BEFORE kill
    expect(callOrder[0]).toBe("deleteForumTopic")
    // kill happens in background, give it time to complete
    await new Promise((r) => setTimeout(r, 100))
    expect(callOrder).toContain("kill")
  })
})

describe("closeChildSessions threadId validation", () => {
  let telegram: TelegramClient
  let config: MinionConfig
  let observer: Observer
  let dispatcher: Dispatcher
  let topicSessions: Map<number, TopicSession>

  beforeEach(() => {
    telegram = makeMockTelegram()
    config = makeConfig()
    observer = new Observer(telegram, 1)
    dispatcher = new Dispatcher(telegram, observer, config)
    topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
  })

  it("returns early when parent.threadId is undefined", async () => {
    // Create multiple unrelated sessions that should NOT be deleted
    const session1: TopicSession = {
      threadId: 101,
      repo: "repo1",
      cwd: "/tmp/ws1",
      slug: "slug1",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    const session2: TopicSession = {
      threadId: 102,
      repo: "repo2",
      cwd: "/tmp/ws2",
      slug: "slug2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(101, session1)
    topicSessions.set(102, session2)

    // Create a parent with undefined threadId (simulates corrupted state)
    const invalidParent: TopicSession = {
      threadId: undefined as unknown as number,
      repo: "parent-repo",
      cwd: "/tmp/parent-ws",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    // Call handleCloseCommand which internally calls closeChildSessions
    await dispatcher.handleCloseCommand(invalidParent.threadId)

    // Verify that no sessions were deleted (validation returned early)
    expect(topicSessions.has(101)).toBe(true)
    expect(topicSessions.has(102)).toBe(true)
    expect(telegram.deleteForumTopic).not.toHaveBeenCalled()
  })

  it("returns early when parent.threadId is NaN", async () => {
    // Create multiple unrelated sessions
    const session1: TopicSession = {
      threadId: 201,
      repo: "repo1",
      cwd: "/tmp/ws1",
      slug: "slug1",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(201, session1)

    // Create a parent with NaN threadId
    const invalidParent: TopicSession = {
      threadId: NaN,
      repo: "parent-repo",
      cwd: "/tmp/parent-ws",
      slug: "parent-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }
    topicSessions.set(NaN, invalidParent)

    // Call handleCloseCommand
    await dispatcher.handleCloseCommand(NaN)

    // Verify that session1 was NOT deleted
    expect(topicSessions.has(201)).toBe(true)
  })
})

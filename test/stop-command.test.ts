import { describe, it, expect, vi } from "vitest"
import { Dispatcher } from "../src/orchestration/dispatcher.js"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import { Observer } from "../src/telegram/observer.js"
import type { MinionConfig } from "../src/config/config-types.js"
import type { TopicSession } from "../src/domain/session-types.js"
import { EventBus } from "../src/events/event-bus.js"

function makeMockPlatform() {
  const chat = {
    sendMessage: vi.fn(async () => ({ ok: true, messageId: "1" })),
    editMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => {}),
  }
  const threads = {
    createThread: vi.fn(async () => ({ threadId: "42", name: "test" })),
    editThread: vi.fn(async () => {}),
    closeThread: vi.fn(async () => {}),
    deleteThread: vi.fn(async () => {}),
  }
  const input = {
    poll: vi.fn(async () => []),
    getCursor: vi.fn(() => "0"),
    advanceCursor: vi.fn(),
  }
  const ui = {
    sendMessageWithKeyboard: vi.fn(async () => "1"),
    answerCallbackQuery: vi.fn(async () => {}),
  }
  const platform = {
    name: "test",
    chat,
    threads,
    input,
    ui,
    files: null,
    formatter: null,
    chatId: "1",
    threadLink: vi.fn(),
  } as unknown as ChatPlatform
  return { platform, chat }
}

function makeConfig(): MinionConfig {
  return {
    telegram: { botToken: "test", chatId: "1", allowedUserIds: [1] },
    telegramQueue: { minSendIntervalMs: 0 },
    workspace: {
      root: "/tmp/test-workspace",
      maxConcurrentSessions: 2,
      maxDagConcurrency: 3,
      maxSplitItems: 10,
      sessionTokenBudget: 100_000,
      sessionBudgetUsd: 0,
      sessionTimeoutMs: 60_000,
      sessionInactivityTimeoutMs: 300_000,
      staleTtlMs: 86_400_000,
      cleanupIntervalMs: 3_600_000,
      maxConversationLength: 50,
      maxJudgeOptions: 6,
      judgeAdvocateTimeoutMs: 120_000,
      judgeTimeoutMs: 300_000,
    },
    repos: {},
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
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
    ci: {
      babysitEnabled: false,
      maxRetries: 0,
      pollIntervalMs: 10_000,
      pollTimeoutMs: 600_000,
      dagCiPolicy: "block",
    },
    observer: { activityThrottleMs: 0, textFlushDebounceMs: 0, activityEditDebounceMs: 0 },
    quota: {
      retryMax: 3,
      defaultSleepMs: 1_800_000,
      sleepBufferMs: 60_000,
    },
  } as MinionConfig
}

describe("handleStopCommand", () => {
  it("kills active session and clears activeSessionId", async () => {
    const { platform, chat } = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: "100",
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [{ role: "user", text: "some feedback" }],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-123",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("100", topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<string, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set("100", {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Use the public API with threadId
    await dispatcher.handleStopCommand("100")

    // Should kill the session
    expect(mockKill).toHaveBeenCalled()
    // Should remove from sessions map
    expect(sessions.has("100")).toBe(false)
    // Should clear activeSessionId
    expect(topicSession.activeSessionId).toBeUndefined()
    // Should clear pendingFeedback
    expect(topicSession.pendingFeedback).toEqual([])
    // Should preserve topic session in map
    expect(topicSessions.has("100")).toBe(true)
    // Should send stopped message
    expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
      "100",
    )
  })

  it("shows warning when no active session", async () => {
    const { platform, chat } = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSession: TopicSession = {
      threadId: "200",
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-2",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      // No activeSessionId
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("200", topicSession)

    // Use the public API with threadId
    await dispatcher.handleStopCommand("200")

    // Should send warning message
    expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("No active session"),
      "200",
    )
    // Topic session should still exist
    expect(topicSessions.has("200")).toBe(true)
  })

  it("preserves conversation history", async () => {
    const { platform, chat } = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: "300",
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-3",
      conversation: [
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "I fixed it" },
      ],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-456",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("300", topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<string, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set("300", {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Use the public API with threadId
    await dispatcher.handleStopCommand("300")

    // Conversation should be preserved
    expect(topicSession.conversation).toHaveLength(2)
    expect(topicSession.conversation[0].text).toBe("fix the bug")
    expect(topicSession.conversation[1].text).toBe("I fixed it")
  })

  it("persists topic sessions after stop", async () => {
    const { platform, chat } = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const mockKill = vi.fn().mockResolvedValue(undefined)

    const topicSession: TopicSession = {
      threadId: "400",
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-4",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "active-session-789",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("400", topicSession)

    const sessions = (dispatcher as unknown as { sessions: Map<string, { handle: { kill: typeof mockKill } }> }).sessions
    sessions.set("400", {
      handle: { kill: mockKill },
    } as unknown as { handle: { kill: typeof mockKill } })

    // Spy on persistTopicSessions
    const persistSpy = vi.spyOn(
      dispatcher as unknown as { persistTopicSessions: () => void },
      "persistTopicSessions",
    )

    // Use the public API with threadId
    await dispatcher.handleStopCommand("400")

    expect(persistSpy).toHaveBeenCalled()
  })

  it("handles session not in sessions map gracefully", async () => {
    const { platform, chat } = makeMockPlatform()
    const config = makeConfig()
    const observer = new Observer(chat, 0)
    const dispatcher = new Dispatcher(platform, observer, config, new EventBus())

    const topicSession: TopicSession = {
      threadId: "500",
      repo: "test-repo",
      cwd: "/tmp/test-workspace",
      slug: "test-slug-5",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      activeSessionId: "orphaned-session-id",
    }

    const topicSessions = (dispatcher as unknown as { topicSessions: Map<string, TopicSession> }).topicSessions
    topicSessions.set("500", topicSession)

    // Don't add to sessions map - simulates orphaned activeSessionId

    // Use the public API with threadId
    await dispatcher.handleStopCommand("500")

    // Should still clear activeSessionId and send message
    expect(topicSession.activeSessionId).toBeUndefined()
    expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
      "500",
    )
  })
})

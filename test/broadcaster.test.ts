import { describe, it, expect, vi } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import { StateBroadcaster } from "../src/api-server.js"
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

function makeTopicSession(threadId: number, slug = "test-slug"): TopicSession {
  return {
    threadId,
    repo: "test-repo",
    cwd: "/tmp/nonexistent-workspace",
    slug,
    conversation: [{ role: "user", text: "/task do something" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
  }
}

describe("Dispatcher broadcaster integration", () => {
  it("broadcasts session_created when a topic session is added", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const broadcaster = new StateBroadcaster()
    dispatcher.setBroadcaster(broadcaster)

    const events: unknown[] = []
    broadcaster.on("event", (event) => events.push(event))

    const topicSession = makeTopicSession(100, "bold-meadow")
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(100, topicSession)

    // Manually trigger what startTopicSession does after set
    const broadcastSession = (dispatcher as unknown as { broadcastSession: (threadId: number, type: string) => void }).broadcastSession
    broadcastSession.call(dispatcher, 100, "session_created")

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "session_created",
      session: {
        id: "bold-meadow",
        slug: "bold-meadow",
        status: "pending",
        command: "/task do something",
        threadId: 100,
      },
    })
  })

  it("broadcasts session_updated with correct status", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const broadcaster = new StateBroadcaster()
    dispatcher.setBroadcaster(broadcaster)

    const events: unknown[] = []
    broadcaster.on("event", (event) => events.push(event))

    const topicSession = makeTopicSession(200, "calm-lake")
    topicSession.activeSessionId = "session-123"
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(200, topicSession)

    const broadcastSession = (dispatcher as unknown as { broadcastSession: (threadId: number, type: string) => void }).broadcastSession
    broadcastSession.call(dispatcher, 200, "session_updated")

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "session_updated",
      session: {
        id: "calm-lake",
        status: "running",
      },
    })
  })

  it("broadcasts session_deleted with slug as sessionId", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const broadcaster = new StateBroadcaster()
    dispatcher.setBroadcaster(broadcaster)

    const events: unknown[] = []
    broadcaster.on("event", (event) => events.push(event))

    const topicSession = makeTopicSession(300, "dark-river")
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(300, topicSession)

    const broadcastSession = (dispatcher as unknown as { broadcastSession: (threadId: number, type: string) => void }).broadcastSession
    broadcastSession.call(dispatcher, 300, "session_deleted")

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "session_deleted",
      sessionId: "dark-river",
    })
  })

  it("does not broadcast when no broadcaster is set", () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)

    const topicSession = makeTopicSession(400)
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(400, topicSession)

    // Should not throw
    const broadcastSession = (dispatcher as unknown as { broadcastSession: (threadId: number, type: string) => void }).broadcastSession
    broadcastSession.call(dispatcher, 400, "session_created")
  })

  it("broadcasts session_deleted on handleCloseCommand", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const broadcaster = new StateBroadcaster()
    dispatcher.setBroadcaster(broadcaster)

    const events: unknown[] = []
    broadcaster.on("event", (event) => events.push(event))

    const topicSession = makeTopicSession(500, "warm-sun")
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(500, topicSession)

    await dispatcher.handleCloseCommand(500)

    const deleteEvents = events.filter((e: unknown) => (e as { type: string }).type === "session_deleted")
    expect(deleteEvents).toHaveLength(1)
    expect(deleteEvents[0]).toEqual({
      type: "session_deleted",
      sessionId: "warm-sun",
    })
  })

  it("broadcasts session_deleted on apiCloseSession", async () => {
    const telegram = makeMockTelegram()
    const config = makeConfig()
    const observer = new Observer(telegram, 1)
    const dispatcher = new Dispatcher(telegram, observer, config)
    const broadcaster = new StateBroadcaster()
    dispatcher.setBroadcaster(broadcaster)

    const events: unknown[] = []
    broadcaster.on("event", (event) => events.push(event))

    const topicSession = makeTopicSession(600, "soft-wind")
    const topicSessions = (dispatcher as unknown as { topicSessions: Map<number, TopicSession> }).topicSessions
    topicSessions.set(600, topicSession)

    await dispatcher.apiCloseSession(600)

    const deleteEvents = events.filter((e: unknown) => (e as { type: string }).type === "session_deleted")
    expect(deleteEvents).toHaveLength(1)
    expect(deleteEvents[0]).toEqual({
      type: "session_deleted",
      sessionId: "soft-wind",
    })
  })
})

describe("SSE event delivery through API server", () => {
  it("broadcasts events to connected SSE clients", async () => {
    const { createApiServer } = await import("../src/api-server.js")
    const broadcaster = new StateBroadcaster()

    const mockDispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
    }

    const server = createApiServer(mockDispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      broadcaster,
    })

    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, () => {
        resolve(server.address() as { port: number })
      })
    })

    try {
      // Connect SSE client
      const response = await fetch(`http://localhost:${address.port}/api/events`)
      expect(response.status).toBe(200)

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      // Broadcast an event
      broadcaster.broadcast({
        type: "session_created",
        session: {
          id: "test",
          slug: "test",
          status: "running",
          command: "/task test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          childIds: [],
          threadId: 123,
        },
      })

      // First read gets the connection comment
      await reader.read()

      // Second read gets the broadcast data
      const { value } = await reader.read()
      const text = decoder.decode(value)
      expect(text).toContain("data:")
      expect(text).toContain("session_created")
      expect(text).toContain("test")

      reader.cancel()
    } finally {
      server.close()
    }
  })
})

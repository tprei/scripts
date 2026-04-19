import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import {
  createApiServer,
  StateBroadcaster,
  topicSessionToApi,
  type DispatcherApi,
  type SseEvent,
} from "../src/api-server.js"
import type { TopicSession } from "../src/domain/session-types.js"
import type { TranscriptEvent, TranscriptSnapshot } from "../src/transcript/types.js"

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
}

function makeTopicSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "org/repo",
    cwd: "/tmp",
    slug: "bold-meadow",
    conversation: [{ role: "user", text: "/task transcript check" }],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeDispatcher(
  overrides: Partial<DispatcherApi> = {},
): DispatcherApi {
  return {
    getSessions: () => new Map(),
    getTopicSessions: () => new Map(),
    getDags: () => new Map(),
    getSessionState: () => undefined,
    sendReply: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    handleIncomingText: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ slug: "unused", threadId: 0 }),
    createSessionVariants: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeEvent(partial: Partial<TranscriptEvent> & Pick<TranscriptEvent, "seq" | "type">): TranscriptEvent {
  const base = {
    id: `e-${partial.seq}`,
    sessionId: "bold-meadow",
    turn: 0,
    timestamp: 1_700_000_000_000 + partial.seq,
  }
  if (partial.type === "assistant_text") {
    return {
      ...base,
      ...partial,
      blockId: "block-1",
      text: "hello",
      final: true,
    } as TranscriptEvent
  }
  if (partial.type === "user_message") {
    return {
      ...base,
      ...partial,
      text: "hi",
    } as TranscriptEvent
  }
  if (partial.type === "turn_started") {
    return { ...base, ...partial, trigger: "user_message" } as TranscriptEvent
  }
  if (partial.type === "turn_completed") {
    return { ...base, ...partial } as TranscriptEvent
  }
  throw new Error(`unsupported event type in fixture: ${partial.type}`)
}

describe("transcriptUrl on ApiSession", () => {
  it("populates transcriptUrl from the session slug", () => {
    const api = topicSessionToApi(makeTopicSession({ slug: "bold-meadow" }), "-100123")
    expect(api.transcriptUrl).toBe("/api/sessions/bold-meadow/transcript")
  })

  it("URL-encodes unusual slugs", () => {
    const api = topicSessionToApi(makeTopicSession({ slug: "foo_bar-baz" }), "-100123")
    expect(api.transcriptUrl).toBe("/api/sessions/foo_bar-baz/transcript")
  })
})

describe("GET /api/sessions/:slug/transcript", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("returns 404 when the session does not exist", async () => {
    const dispatcher = makeDispatcher({
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/missing/transcript`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Session not found")
    expect(dispatcher.getTranscript).not.toHaveBeenCalled()
  })

  it("returns 501 when the minion has no transcript store", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(501)
    expect(body.error).toMatch(/transcript/i)
  })

  it("returns a full snapshot when no `after` query param is provided", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const events = [
      makeEvent({ seq: 0, type: "turn_started" }),
      makeEvent({ seq: 1, type: "user_message" }),
      makeEvent({ seq: 2, type: "assistant_text" }),
    ]
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events,
      highWaterMark: 2,
    }
    const getTranscript = vi.fn().mockReturnValue(snapshot)
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(getTranscript).toHaveBeenCalledWith("bold-meadow", -1)
    expect(body.data.highWaterMark).toBe(2)
    expect(body.data.events).toHaveLength(3)
    expect(body.data.events[0].type).toBe("turn_started")
  })

  it("forwards the `after` query param as an integer seq", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const events = [makeEvent({ seq: 3, type: "assistant_text" })]
    const snapshot: TranscriptSnapshot = {
      session: { sessionId: "bold-meadow", startedAt: 1_700_000_000_000 },
      events,
      highWaterMark: 3,
    }
    const getTranscript = vi.fn().mockReturnValue(snapshot)
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=2`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(getTranscript).toHaveBeenCalledWith("bold-meadow", 2)
    expect(body.data.events).toHaveLength(1)
    expect(body.data.events[0].seq).toBe(3)
  })

  it("rejects non-integer `after` values", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const getTranscript = vi.fn()
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript,
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=abc`)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/integer/i)
    expect(getTranscript).not.toHaveBeenCalled()
  })

  it("rejects `after` values below -1", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn(),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript?after=-2`)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/integer/i)
  })

  it("returns 404 when getTranscript returns undefined (e.g. unknown session at store level)", async () => {
    const topicSessions = new Map<number, TopicSession>()
    topicSessions.set(1, makeTopicSession())
    const dispatcher = makeDispatcher({
      getTopicSessions: () => topicSessions,
      getTranscript: vi.fn().mockReturnValue(undefined),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/sessions/bold-meadow/transcript`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Session not found")
  })
})

describe("GET /api/version transcript feature flag", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
  })

  afterEach(() => {
    server?.close()
  })

  it("advertises transcript feature when the dispatcher provides getTranscript", async () => {
    const dispatcher = makeDispatcher({
      getTranscript: vi.fn().mockReturnValue(undefined),
    })
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(body.data.features).toContain("transcript")
  })

  it("omits transcript feature when dispatcher does not expose getTranscript", async () => {
    const dispatcher = makeDispatcher()
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/version`)
    const body = await res.json()

    expect(body.data.features).not.toContain("transcript")
  })
})

describe("StateBroadcaster transcript_event fan-out", () => {
  it("emits transcript_event SseEvents to subscribers", () => {
    const broadcaster = new StateBroadcaster()
    const event: SseEvent = {
      type: "transcript_event",
      sessionId: "bold-meadow",
      event: {
        seq: 0,
        id: "e-0",
        sessionId: "bold-meadow",
        turn: 0,
        timestamp: 1_700_000_000_000,
        type: "assistant_text",
        blockId: "b0",
        text: "hi",
        final: true,
      },
    }
    const listener = vi.fn()
    broadcaster.on("event", listener)
    broadcaster.broadcast(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)
  })
})

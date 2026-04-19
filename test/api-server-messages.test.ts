import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import http from "node:http"
import { createApiServer, StateBroadcaster, type DispatcherApi, type CreateSessionRequest } from "../src/api-server.js"

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
}

describe("POST /api/messages", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let handleIncomingText: ReturnType<typeof vi.fn>
  let dispatcher: DispatcherApi

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
    handleIncomingText = vi.fn().mockResolvedValue(undefined)
    dispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
      handleIncomingText,
      createSession: vi.fn().mockResolvedValue({ slug: "unused", threadId: 0 }),
      createSessionVariants: vi.fn().mockResolvedValue([]),
    }
  })

  afterEach(() => {
    server?.close()
  })

  it("calls dispatcher.handleIncomingText and returns ok", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/task hi" }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: { ok: true, sessionId: null } })
    expect(handleIncomingText).toHaveBeenCalledWith("/task hi", undefined)
  })

  it("passes sessionId to dispatcher.handleIncomingText", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", sessionId: "bold-meadow" }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: { ok: true, sessionId: "bold-meadow" } })
    expect(handleIncomingText).toHaveBeenCalledWith("hello", "bold-meadow")
  })

  it("returns 400 for empty text", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ data: null, error: "text required" })
    expect(handleIncomingText).not.toHaveBeenCalled()
  })

  it("returns 400 for missing text field", async () => {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      chatId: "-1001234567890",
      botToken: "test-bot-token",
      broadcaster,
    })
    const port = await listen(server)

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ data: null, error: "text required" })
  })
})

describe("POST /api/sessions", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let createSession: ReturnType<typeof vi.fn>
  let dispatcher: DispatcherApi

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
    createSession = vi.fn()
    dispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
      handleIncomingText: vi.fn().mockResolvedValue(undefined),
      createSession,
      createSessionVariants: vi.fn().mockResolvedValue([]),
    }
  })

  afterEach(() => {
    server?.close()
  })

  async function start(): Promise<number> {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    return listen(server)
  }

  it("creates a session and returns 201 with slug + threadId", async () => {
    createSession.mockResolvedValueOnce({ slug: "bold-meadow", threadId: 42 })
    const port = await start()

    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "scripts", prompt: "fix the bug", mode: "task" }),
    })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body).toEqual({ data: { sessionId: "bold-meadow", slug: "bold-meadow", threadId: 42 } })
    expect(createSession).toHaveBeenCalledWith<[CreateSessionRequest]>({
      repo: "scripts",
      prompt: "fix the bug",
      mode: "task",
      profileId: undefined,
    })
  })

  it("defaults mode to undefined (engine picks 'task')", async () => {
    createSession.mockResolvedValueOnce({ slug: "sess", threadId: 1 })
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi there" }),
    })

    expect(res.status).toBe(201)
    expect(createSession).toHaveBeenCalledWith({
      repo: undefined,
      prompt: "hi there",
      mode: undefined,
      profileId: undefined,
    })
  })

  it("rejects empty prompts with 400", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ data: null, error: "prompt is required" })
    expect(createSession).not.toHaveBeenCalled()
  })

  it("rejects unknown modes with 400", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "p", mode: "bogus" }),
    })

    expect(res.status).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })

  it("returns 500 when engine.createSession throws", async () => {
    createSession.mockRejectedValueOnce(new Error("workspace boom"))
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "p" }),
    })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toEqual({ data: null, error: "workspace boom" })
  })

  it("returns 400 on invalid JSON body", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this is not json",
    })

    expect(res.status).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })
})

describe("POST /api/sessions/variants", () => {
  let server: http.Server
  let broadcaster: StateBroadcaster
  let createSessionVariants: ReturnType<typeof vi.fn>
  let dispatcher: DispatcherApi

  beforeEach(() => {
    broadcaster = new StateBroadcaster()
    createSessionVariants = vi.fn()
    dispatcher = {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
      handleIncomingText: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ slug: "unused", threadId: 0 }),
      createSessionVariants,
    }
  })

  afterEach(() => {
    server?.close()
  })

  async function start(): Promise<number> {
    server = createApiServer(dispatcher, {
      port: 0,
      uiDistPath: "/nonexistent",
      broadcaster,
    })
    return listen(server)
  }

  it("spawns N variants and returns 201 with one entry per variant", async () => {
    createSessionVariants.mockResolvedValueOnce([
      { slug: "a1", threadId: 1 },
      { slug: "a2", threadId: 2 },
      { slug: "a3", threadId: 3 },
    ])
    const port = await start()

    const res = await fetch(`http://localhost:${port}/api/sessions/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "fix it", count: 3 }),
    })
    const body = await res.json() as { data: { sessions: { slug: string }[] } }

    expect(res.status).toBe(201)
    expect(body.data.sessions.map((s) => s.slug)).toEqual(["a1", "a2", "a3"])
    expect(createSessionVariants).toHaveBeenCalledWith(
      { repo: undefined, prompt: "fix it", mode: undefined, profileId: undefined },
      3,
    )
  })

  it("passes per-variant failures back to the client", async () => {
    createSessionVariants.mockResolvedValueOnce([
      { slug: "x1", threadId: 10 },
      { error: "workspace boom" },
    ])
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "p", count: 2 }),
    })
    const body = await res.json() as { data: { sessions: ({ slug: string } | { error: string })[] } }
    expect(res.status).toBe(201)
    expect(body.data.sessions).toEqual([
      { sessionId: "x1", slug: "x1", threadId: 10 },
      { error: "workspace boom" },
    ])
  })

  it("rejects count < 2", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "p", count: 1 }),
    })
    expect(res.status).toBe(400)
    expect(createSessionVariants).not.toHaveBeenCalled()
  })

  it("rejects count > 10", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "p", count: 11 }),
    })
    expect(res.status).toBe(400)
    expect(createSessionVariants).not.toHaveBeenCalled()
  })

  it("rejects empty prompts", async () => {
    const port = await start()
    const res = await fetch(`http://localhost:${port}/api/sessions/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "  ", count: 2 }),
    })
    expect(res.status).toBe(400)
    expect(createSessionVariants).not.toHaveBeenCalled()
  })
})

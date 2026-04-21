import { describe, it, expect, beforeEach, afterEach } from "vitest"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createApiServer,
  StateBroadcaster,
  type DispatcherApi,
} from "../src/api-server.js"
import {
  RuntimeOverridesStore,
  buildSchema,
} from "../src/config/runtime-overrides.js"
import type { ResourceSnapshot } from "../src/metrics/types.js"

async function boundServer(dispatcher: DispatcherApi, broadcaster: StateBroadcaster, apiToken?: string) {
  const server = createApiServer(dispatcher, {
    port: 0,
    uiDistPath: "/nonexistent",
    broadcaster,
    apiToken,
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  })
  return { server, port }
}

const sampleSnapshot = (): ResourceSnapshot => ({
  ts: Date.now(),
  cpu: { usagePercent: 42, cpuCount: 4, source: "cgroup" },
  memory: { usedBytes: 100, limitBytes: 1000, rssBytes: 80, source: "cgroup" },
  disk: { path: "/workspace", usedBytes: 1, totalBytes: 10 },
  eventLoopLagMs: 0.5,
  counts: { activeSessions: 1, maxSessions: 5, activeLoops: 0, maxLoops: 3 },
})

describe("API server — resource metrics + runtime config", () => {
  let workspace: string
  let server: http.Server | undefined
  let broadcaster: StateBroadcaster

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "api-runtime-"))
    broadcaster = new StateBroadcaster()
  })

  afterEach(async () => {
    if (server) server.close()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  function baseDispatcher(overrides: Partial<DispatcherApi> = {}): DispatcherApi {
    return {
      getSessions: () => new Map(),
      getTopicSessions: () => new Map(),
      getDags: () => new Map(),
      getSessionState: () => undefined,
      sendReply: async () => {},
      stopSession: () => {},
      closeSession: async () => {},
      handleIncomingText: async () => {},
      createSession: async () => ({ slug: "", threadId: 0 }),
      createSessionVariants: async () => [],
      ...overrides,
    }
  }

  it("GET /api/metrics returns 501 when collector is not wired", async () => {
    const d = baseDispatcher()
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/metrics`)
    expect(res.status).toBe(501)
  })

  it("GET /api/metrics returns latest snapshot", async () => {
    const snap = sampleSnapshot()
    const d = baseDispatcher({ getResourceSnapshot: () => snap })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/metrics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: ResourceSnapshot }
    expect(body.data.cpu.usagePercent).toBe(42)
  })

  it("GET /api/version advertises resource-metrics + runtime-config when wired", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const schema = buildSchema([])
    const d = baseDispatcher({
      getResourceSnapshot: () => sampleSnapshot(),
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => schema,
      getBaseConfig: () => ({}),
    })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/version`)
    const body = (await res.json()) as { data: { features: string[] } }
    expect(body.data.features).toContain("resource-metrics")
    expect(body.data.features).toContain("runtime-config")
  })

  it("GET /api/config/runtime returns base + overrides + schema", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    await store.patch({ workspace: { maxConcurrentSessions: 7 } }, new Set())
    const schema = buildSchema([])
    const d = baseDispatcher({
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => schema,
      getBaseConfig: () => ({ workspace: { maxConcurrentSessions: 5 } }),
    })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/config/runtime`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { base: unknown; overrides: unknown; schema: unknown }
    }
    expect(body.data.base).toEqual({ workspace: { maxConcurrentSessions: 5 } })
    expect(body.data.overrides).toEqual({ workspace: { maxConcurrentSessions: 7 } })
    expect(body.data.schema).toEqual(schema)
  })

  it("PATCH /api/config/runtime with invalid JSON returns 400", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const d = baseDispatcher({
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => buildSchema([]),
      getBaseConfig: () => ({}),
    })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/config/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  it("PATCH /api/config/runtime with validation error returns 400", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const d = baseDispatcher({
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => buildSchema([]),
      getBaseConfig: () => ({}),
    })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/config/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: { maxConcurrentSessions: -1 } }),
    })
    expect(res.status).toBe(400)
  })

  it("PATCH /api/config/runtime persists and flags requires-restart fields", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const schema = buildSchema([
      { id: "alpha", name: "Alpha", defaultEnabled: true, defaultIntervalMs: 60_000 },
    ])
    const d = baseDispatcher({
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => schema,
      getBaseConfig: () => ({ foo: "bar" }),
    })
    const b = await boundServer(d, broadcaster)
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/config/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mcp: { githubEnabled: false },
        workspace: { maxConcurrentSessions: 6 },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { overrides: { mcp: { githubEnabled: boolean } }; requiresRestart: string[] }
    }
    expect(body.data.overrides.mcp.githubEnabled).toBe(false)
    expect(body.data.requiresRestart).toContain("mcp.githubEnabled")
    expect(body.data.requiresRestart).not.toContain("workspace.maxConcurrentSessions")
  })

  it("PATCH /api/config/runtime without bearer returns 401 when token is set", async () => {
    const store = new RuntimeOverridesStore(workspace)
    await store.load()
    const d = baseDispatcher({
      getRuntimeOverridesStore: () => store,
      getRuntimeOverridesSchema: () => buildSchema([]),
      getBaseConfig: () => ({}),
    })
    const b = await boundServer(d, broadcaster, "secret-token")
    server = b.server
    const res = await fetch(`http://localhost:${b.port}/api/config/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it("SSE stream receives resource events", async () => {
    const snap = sampleSnapshot()
    const d = baseDispatcher({ getResourceSnapshot: () => snap })
    const b = await boundServer(d, broadcaster)
    server = b.server

    const res = await fetch(`http://localhost:${b.port}/api/events`, {
      headers: { Accept: "text/event-stream" },
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    setTimeout(() => broadcaster.broadcast({ type: "resource", snapshot: snap }), 30)

    let received = ""
    const deadline = Date.now() + 2000
    while (!received.includes('"type":"resource"') && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    expect(received).toContain('"type":"resource"')
  })
})

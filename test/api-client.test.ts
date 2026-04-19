import { describe, it, expect, beforeAll, afterAll } from "vitest"
import http from "node:http"
import { createApiClient } from "../src/api/client.js"

function createStubServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    res.setHeader("Content-Type", "application/json")

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "s1", slug: "s1", status: "running" }] }))
      return
    }

    if (url.pathname === "/api/sessions/s1" && req.method === "GET") {
      res.end(JSON.stringify({ data: { id: "s1", slug: "s1", status: "running" } }))
      return
    }

    if (url.pathname === "/api/sessions/s1/diff" && req.method === "GET") {
      res.end(JSON.stringify({ data: { base: "main", head: "HEAD", patch: "+line", truncated: false } }))
      return
    }

    if (url.pathname === "/api/sessions/s1/screenshots" && req.method === "GET") {
      res.end(JSON.stringify({
        data: {
          screenshots: [{ filename: "shot.png", sizeBytes: 100, capturedAt: "2025-01-01T00:00:00Z", url: "/api/sessions/s1/screenshots/shot.png" }],
        },
      }))
      return
    }

    if (url.pathname === "/api/sessions/s1/pr" && req.method === "GET") {
      res.end(JSON.stringify({
        data: { url: "https://github.com/test/1", number: 1, title: "test", body: "", state: "OPEN", mergeable: null, isDraft: false, baseRefName: "main", headRefName: "feat", author: "bot", updatedAt: null, checks: [] },
      }))
      return
    }

    if (url.pathname === "/api/dags" && req.method === "GET") {
      res.end(JSON.stringify({ data: [] }))
      return
    }

    if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET") {
      res.end(JSON.stringify({ data: { publicKey: "test-key" } }))
      return
    }

    if (url.pathname === "/api/push-subscribe" && req.method === "POST") {
      res.writeHead(201)
      res.end(JSON.stringify({ data: { subscribed: true } }))
      return
    }

    if (url.pathname === "/api/push-subscribe" && req.method === "DELETE") {
      res.end(JSON.stringify({ data: { removed: true } }))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ data: null, error: "not found" }))
  })
}

describe("createApiClient", () => {
  let server: http.Server
  let baseUrl: string

  beforeAll(async () => {
    server = createStubServer()
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(() => {
    server.close()
  })

  it("fetches sessions", async () => {
    const client = createApiClient({ baseUrl })
    const sessions = await client.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].slug).toBe("s1")
  })

  it("fetches a single session", async () => {
    const client = createApiClient({ baseUrl })
    const session = await client.getSession("s1")
    expect(session.slug).toBe("s1")
  })

  it("fetches diff", async () => {
    const client = createApiClient({ baseUrl })
    const diff = await client.getDiff("s1")
    expect(diff.base).toBe("main")
    expect(diff.patch).toBe("+line")
  })

  it("lists screenshots", async () => {
    const client = createApiClient({ baseUrl })
    const shots = await client.listScreenshots("s1")
    expect(shots).toHaveLength(1)
    expect(shots[0].filename).toBe("shot.png")
  })

  it("fetches PR preview", async () => {
    const client = createApiClient({ baseUrl })
    const pr = await client.getPr("s1")
    expect(pr.state).toBe("OPEN")
  })

  it("fetches VAPID public key", async () => {
    const client = createApiClient({ baseUrl })
    const key = await client.getVapidKey()
    expect(key.publicKey).toBe("test-key")
  })

  it("subscribes to push", async () => {
    const client = createApiClient({ baseUrl })
    await expect(
      client.subscribePush({ endpoint: "https://push.example.com", keys: { p256dh: "a", auth: "b" } }),
    ).resolves.toBeUndefined()
  })

  it("unsubscribes from push", async () => {
    const client = createApiClient({ baseUrl })
    await expect(client.unsubscribePush("https://push.example.com")).resolves.toBeUndefined()
  })

  it("fetches DAGs", async () => {
    const client = createApiClient({ baseUrl })
    const dags = await client.getDags()
    expect(dags).toEqual([])
  })
})

import http from "node:http"

export interface MockFeatureFlags {
  messages: boolean
  auth: boolean
  "cors-allowlist": boolean
  repos: boolean
  "sessions-create": boolean
  "diff-viewer": boolean
  "screenshots-http": boolean
  "pr-preview": boolean
  "parallel-variants": boolean
  "web-push": boolean
}

const DEFAULT_FLAGS: MockFeatureFlags = {
  messages: false,
  auth: false,
  "cors-allowlist": false,
  repos: false,
  "sessions-create": false,
  "diff-viewer": false,
  "screenshots-http": false,
  "pr-preview": false,
  "parallel-variants": false,
  "web-push": false,
}

export interface MockMinionOptions {
  port?: number
  features?: Partial<MockFeatureFlags>
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export function createMockMinion(options: MockMinionOptions = {}): http.Server {
  const flags: MockFeatureFlags = { ...DEFAULT_FLAGS, ...options.features }

  const enabledFeatures = (Object.entries(flags) as [string, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`)

    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === "/api/version" && req.method === "GET") {
      json(res, 200, {
        data: {
          apiVersion: "1",
          libraryVersion: "0.0.0-mock",
          features: enabledFeatures,
          repos: [],
        },
      })
      return
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      json(res, 200, { data: [] })
      return
    }

    if (url.pathname === "/api/dags" && req.method === "GET") {
      json(res, 200, { data: [] })
      return
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })
      res.write(": connected\n\n")
      return
    }

    if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET") {
      if (!flags["web-push"]) {
        json(res, 503, { data: null, error: "Web Push is not configured on this minion" })
        return
      }
      json(res, 200, { data: { publicKey: "mock-vapid-public-key" } })
      return
    }

    json(res, 404, { data: null, error: "Not found" })
  })

  return server
}

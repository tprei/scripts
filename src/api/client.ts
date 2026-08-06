import type {
  CreateSessionRequest,
  PrPreview,
  WorkspaceDiff,
  ScreenshotEntry,
  VapidPublicKey,
  PushSubscriptionJSON,
} from "./types.js"
import type {
  ApiSession,
  ApiDagGraph,
  ApiResponse,
  CommandResult,
  MinionCommand,
  CreateSessionVariantResult,
} from "../api-server.js"

export interface ApiClient {
  getSessions(): Promise<ApiSession[]>
  getSession(slug: string): Promise<ApiSession>
  getDags(): Promise<ApiDagGraph[]>
  getDag(id: string): Promise<ApiDagGraph>
  sendCommand(command: MinionCommand): Promise<CommandResult>
  createSession(request: CreateSessionRequest): Promise<{ sessionId: string; slug: string; threadId: number }>
  createSessionVariants(request: CreateSessionRequest, count: number): Promise<CreateSessionVariantResult[]>
  getDiff(sessionSlug: string): Promise<WorkspaceDiff>
  listScreenshots(sessionSlug: string): Promise<ScreenshotEntry[]>
  fetchScreenshotBlob(sessionSlug: string, filename: string): Promise<Blob>
  getPr(sessionSlug: string): Promise<PrPreview>
  getVapidKey(): Promise<VapidPublicKey>
  subscribePush(subscription: PushSubscriptionJSON): Promise<void>
  unsubscribePush(endpoint: string): Promise<void>
}

export interface ApiClientOptions {
  baseUrl: string
  token?: string
}

async function request<T>(baseUrl: string, path: string, init: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, token } = options

  function get<T>(path: string): Promise<T> {
    return request<T>(baseUrl, path, { method: "GET" }, token)
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(
      baseUrl,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      token,
    )
  }

  function del<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(
      baseUrl,
      path,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      token,
    )
  }

  return {
    async getSessions(): Promise<ApiSession[]> {
      const res = await get<ApiResponse<ApiSession[]>>("/api/sessions")
      return res.data
    },

    async getSession(slug: string): Promise<ApiSession> {
      const res = await get<ApiResponse<ApiSession>>(`/api/sessions/${encodeURIComponent(slug)}`)
      return res.data
    },

    async getDags(): Promise<ApiDagGraph[]> {
      const res = await get<ApiResponse<ApiDagGraph[]>>("/api/dags")
      return res.data
    },

    async getDag(id: string): Promise<ApiDagGraph> {
      const res = await get<ApiResponse<ApiDagGraph>>(`/api/dags/${encodeURIComponent(id)}`)
      return res.data
    },

    async sendCommand(command: MinionCommand): Promise<CommandResult> {
      return post<CommandResult>("/api/commands", command)
    },

    async createSession(req: CreateSessionRequest): Promise<{ sessionId: string; slug: string; threadId: number }> {
      const res = await post<ApiResponse<{ sessionId: string; slug: string; threadId: number }>>("/api/sessions", req)
      return res.data
    },

    async createSessionVariants(req: CreateSessionRequest, count: number): Promise<CreateSessionVariantResult[]> {
      const res = await post<ApiResponse<{ sessions: CreateSessionVariantResult[] }>>(
        "/api/sessions/variants",
        { ...req, count },
      )
      return res.data.sessions
    },

    async getDiff(sessionSlug: string): Promise<WorkspaceDiff> {
      const res = await get<ApiResponse<WorkspaceDiff>>(`/api/sessions/${encodeURIComponent(sessionSlug)}/diff`)
      return res.data
    },

    async listScreenshots(sessionSlug: string): Promise<ScreenshotEntry[]> {
      const res = await get<ApiResponse<{ screenshots: ScreenshotEntry[] }>>(
        `/api/sessions/${encodeURIComponent(sessionSlug)}/screenshots`,
      )
      return res.data.screenshots
    },

    async fetchScreenshotBlob(sessionSlug: string, filename: string): Promise<Blob> {
      const headers: Record<string, string> = {}
      if (token) {
        headers["Authorization"] = `Bearer ${token}`
      }
      const res = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionSlug)}/screenshots/${encodeURIComponent(filename)}`,
        { headers },
      )
      if (!res.ok) {
        throw new Error(`API ${res.status}: screenshot fetch failed`)
      }
      return res.blob()
    },

    async getPr(sessionSlug: string): Promise<PrPreview> {
      const res = await get<ApiResponse<PrPreview>>(`/api/sessions/${encodeURIComponent(sessionSlug)}/pr`)
      return res.data
    },

    async getVapidKey(): Promise<VapidPublicKey> {
      const res = await get<ApiResponse<VapidPublicKey>>("/api/push/vapid-public-key")
      return res.data
    },

    async subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
      await post("/api/push-subscribe", subscription)
    },

    async unsubscribePush(endpoint: string): Promise<void> {
      await del("/api/push-subscribe", { endpoint })
    },
  }
}

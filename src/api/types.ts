export type CreateSessionMode = "task" | "plan" | "think" | "review" | "ship-think"

export interface CreateSessionRequest {
  repo?: string
  prompt: string
  mode?: CreateSessionMode
  profileId?: string
}

export interface PrPreview {
  url: string
  number: number
  title: string
  body: string
  state: "OPEN" | "CLOSED" | "MERGED"
  mergeable: string | null
  isDraft: boolean
  baseRefName: string
  headRefName: string
  author: string | null
  updatedAt: string | null
  checks: { name: string; status: string; conclusion: string | null }[]
}

export interface WorkspaceDiff {
  base: string
  head: string
  patch: string
  truncated: boolean
}

export interface ScreenshotEntry {
  filename: string
  sizeBytes: number
  capturedAt: string
  url: string
}

export interface VapidPublicKey {
  publicKey: string
}

export interface PushSubscriptionJSON {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

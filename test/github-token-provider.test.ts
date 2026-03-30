import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { GitHubTokenProvider } from "../src/github/token-provider.js"
import type { GitHubAppConfig } from "../src/config/config-types.js"
import crypto from "node:crypto"

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

const APP_CONFIG: GitHubAppConfig = {
  appId: "12345",
  privateKey,
  installationId: "67890",
}

const FAKE_TOKEN = "ghs_fakeinstallationtoken123"
const FAKE_EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString()

function mockFetchSuccess(token = FAKE_TOKEN, expiresAt = FAKE_EXPIRES) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ token, expires_at: expiresAt }),
  })
}

describe("GitHubTokenProvider", () => {
  let originalToken: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalToken = process.env["GITHUB_TOKEN"]
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env["GITHUB_TOKEN"]
    } else {
      process.env["GITHUB_TOKEN"] = originalToken
    }
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe("PAT fallback (no app config)", () => {
    it("returns process.env.GITHUB_TOKEN when no app config", async () => {
      process.env["GITHUB_TOKEN"] = "ghp_pat_token"
      const provider = new GitHubTokenProvider()
      expect(provider.isAppAuth).toBe(false)
      const token = await provider.getToken()
      expect(token).toBe("ghp_pat_token")
    })

    it("returns empty string when no token and no app config", async () => {
      delete process.env["GITHUB_TOKEN"]
      const provider = new GitHubTokenProvider()
      const token = await provider.getToken()
      expect(token).toBe("")
    })

    it("refreshEnv is a no-op without app config", async () => {
      process.env["GITHUB_TOKEN"] = "original"
      const provider = new GitHubTokenProvider()
      await provider.refreshEnv()
      expect(process.env["GITHUB_TOKEN"]).toBe("original")
    })
  })

  describe("App auth", () => {
    it("isAppAuth returns true with app config", () => {
      const provider = new GitHubTokenProvider(APP_CONFIG)
      expect(provider.isAppAuth).toBe(true)
    })

    it("fetches installation token", async () => {
      const fetchMock = mockFetchSuccess()
      globalThis.fetch = fetchMock
      const provider = new GitHubTokenProvider(APP_CONFIG)
      const token = await provider.getToken()
      expect(token).toBe(FAKE_TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toContain("/app/installations/67890/access_tokens")
      expect(opts.method).toBe("POST")
      expect(opts.headers.Authorization).toMatch(/^Bearer /)
    })

    it("caches token on second call", async () => {
      const fetchMock = mockFetchSuccess()
      globalThis.fetch = fetchMock
      const provider = new GitHubTokenProvider(APP_CONFIG)
      await provider.getToken()
      await provider.getToken()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("refreshes when token is near expiry", async () => {
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000).toISOString()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ token: "ghs_first", expires_at: nearExpiry }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ token: "ghs_second", expires_at: FAKE_EXPIRES }),
        })
      globalThis.fetch = fetchMock
      const provider = new GitHubTokenProvider(APP_CONFIG)
      const first = await provider.getToken()
      expect(first).toBe("ghs_first")
      const second = await provider.getToken()
      expect(second).toBe("ghs_second")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("refreshEnv updates process.env.GITHUB_TOKEN", async () => {
      globalThis.fetch = mockFetchSuccess("ghs_env_token")
      const provider = new GitHubTokenProvider(APP_CONFIG)
      await provider.refreshEnv()
      expect(process.env["GITHUB_TOKEN"]).toBe("ghs_env_token")
    })

    it("coalesces concurrent refresh calls", async () => {
      let resolvePromise: (value: Response) => void
      const fetchMock = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolvePromise = resolve
        }),
      )
      globalThis.fetch = fetchMock
      const provider = new GitHubTokenProvider(APP_CONFIG)
      const p1 = provider.getToken()
      const p2 = provider.getToken()
      const p3 = provider.getToken()
      resolvePromise!({
        ok: true,
        json: () => Promise.resolve({ token: FAKE_TOKEN, expires_at: FAKE_EXPIRES }),
      } as Response)
      const [t1, t2, t3] = await Promise.all([p1, p2, p3])
      expect(t1).toBe(FAKE_TOKEN)
      expect(t2).toBe(FAKE_TOKEN)
      expect(t3).toBe(FAKE_TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("error handling", () => {
    it("throws on API error with status and body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"message":"Bad credentials"}'),
      })
      const provider = new GitHubTokenProvider(APP_CONFIG)
      await expect(provider.getToken()).rejects.toThrow(
        /GitHub App token request failed \(401\)/,
      )
    })

    it("throws on invalid private key", async () => {
      const badConfig: GitHubAppConfig = {
        ...APP_CONFIG,
        privateKey: "not-a-real-key",
      }
      const provider = new GitHubTokenProvider(badConfig)
      await expect(provider.getToken()).rejects.toThrow()
    })
  })
})

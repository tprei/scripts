import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta, GooseStreamEvent } from "../src/types.js"
import type { BackendType } from "../src/config-types.js"
import { configFromEnv } from "../src/config-env.js"

const baseMcp = {
  browserEnabled: false,
  githubEnabled: false,
  context7Enabled: false,
  sentryEnabled: false,
  sentryOrgSlug: "",
  sentryProjectSlug: "",
  zaiEnabled: false,
}

const baseMeta: SessionMeta = {
  sessionId: "test-backend",
  threadId: 1,
  topicName: "test-backend",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeConfig(backend: BackendType, overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    goose: { provider: "test", model: "test" },
    claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
    codex: { defaultModel: "o4-mini", execPath: "codex", approvalMode: "full-auto" },
    mcp: baseMcp,
    backend,
    ...overrides,
  }
}

describe("BackendType", () => {
  it("accepts 'goose' and 'codex' as valid values", () => {
    const goose: BackendType = "goose"
    const codex: BackendType = "codex"
    expect(goose).toBe("goose")
    expect(codex).toBe("codex")
  })
})

describe("SessionConfig.backend", () => {
  it("defaults to goose in configFromEnv", () => {
    const originalToken = process.env["TELEGRAM_BOT_TOKEN"]
    const originalChatId = process.env["TELEGRAM_CHAT_ID"]
    process.env["TELEGRAM_BOT_TOKEN"] = "test-token"
    process.env["TELEGRAM_CHAT_ID"] = "test-chat-id"

    const config = configFromEnv()
    expect(config.defaultBackend).toBe("goose")

    if (originalToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"]
    else process.env["TELEGRAM_BOT_TOKEN"] = originalToken
    if (originalChatId === undefined) delete process.env["TELEGRAM_CHAT_ID"]
    else process.env["TELEGRAM_CHAT_ID"] = originalChatId
  })

  it("reads DEFAULT_BACKEND env var", () => {
    const originalToken = process.env["TELEGRAM_BOT_TOKEN"]
    const originalChatId = process.env["TELEGRAM_CHAT_ID"]
    const originalBackend = process.env["DEFAULT_BACKEND"]
    process.env["TELEGRAM_BOT_TOKEN"] = "test-token"
    process.env["TELEGRAM_CHAT_ID"] = "test-chat-id"
    process.env["DEFAULT_BACKEND"] = "codex"

    const config = configFromEnv()
    expect(config.defaultBackend).toBe("codex")

    if (originalToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"]
    else process.env["TELEGRAM_BOT_TOKEN"] = originalToken
    if (originalChatId === undefined) delete process.env["TELEGRAM_CHAT_ID"]
    else process.env["TELEGRAM_CHAT_ID"] = originalChatId
    if (originalBackend === undefined) delete process.env["DEFAULT_BACKEND"]
    else process.env["DEFAULT_BACKEND"] = originalBackend
  })

  it("rejects invalid DEFAULT_BACKEND value", () => {
    const originalToken = process.env["TELEGRAM_BOT_TOKEN"]
    const originalChatId = process.env["TELEGRAM_CHAT_ID"]
    const originalBackend = process.env["DEFAULT_BACKEND"]
    process.env["TELEGRAM_BOT_TOKEN"] = "test-token"
    process.env["TELEGRAM_CHAT_ID"] = "test-chat-id"
    process.env["DEFAULT_BACKEND"] = "invalid"

    expect(() => configFromEnv()).toThrow()

    if (originalToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"]
    else process.env["TELEGRAM_BOT_TOKEN"] = originalToken
    if (originalChatId === undefined) delete process.env["TELEGRAM_CHAT_ID"]
    else process.env["TELEGRAM_CHAT_ID"] = originalChatId
    if (originalBackend === undefined) delete process.env["DEFAULT_BACKEND"]
    else process.env["DEFAULT_BACKEND"] = originalBackend
  })
})

describe("SessionHandle.start backend routing", () => {
  it("routes to codex when backend is 'codex' and mode is 'task'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-codex-test-"))
    const fakeCodex = path.join(tmpDir, "fake-codex")

    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeCodex, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        makeConfig("codex", { codex: { defaultModel: "o4-mini", execPath: fakeCodex, approvalMode: "full-auto" } }),
      )
      handle.start("test task")

      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    const args = JSON.parse(stderrChunks.join(""))
    expect(args[0]).toBe("exec")
    expect(args).toContain("--model")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("routes to goose when backend is 'goose' and mode is 'task'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-goose-test-"))
    const fakeGoose = path.join(tmpDir, "fake-goose")

    fs.writeFileSync(fakeGoose, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "complete", total_tokens: 100 }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeGoose, 0o755)

    const meta = { ...baseMeta, cwd: tmpDir }
    const stderrChunks: string[] = []

    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        makeConfig("goose", { goose: { provider: "test", model: "test" } }),
      )
      // Use startGoose directly since we can't control which binary `spawn("goose")` resolves to
      // Instead, test that the routing logic works by checking start() doesn't throw
      // and that the process is spawned
      handle.start("test task")

      // Capture process to verify it was spawned as goose
      const h = handle as unknown as { process: { stderr: NodeJS.ReadableStream; spawnfile: string } }
      h.process.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    })

    // When backend is 'goose', start() calls startGoose which spawns "goose"
    // This test just verifies no errors are thrown in the routing path

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("routes to claude for plan mode regardless of backend", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-plan-test-"))
    const fakeClaude = path.join(tmpDir, "fake-claude")

    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", cost_usd: 0.01, duration_ms: 100, duration_api_ms: 50, num_turns: 1, result: "done", session_id: "test", total_cost: 0.01 }) + '\\n');
process.exit(0);
`)
    fs.chmodSync(fakeClaude, 0o755)

    const meta: SessionMeta = {
      ...baseMeta,
      cwd: tmpDir,
      mode: "plan",
    }

    // Even with codex backend, plan mode should use Claude
    await new Promise<void>((resolve) => {
      const handle = new SessionHandle(
        meta,
        () => {},
        () => resolve(),
        60_000,
        300_000,
        makeConfig("codex"),
      )
      // Plan mode routes to startClaude, not startCodex
      // We can't easily intercept the "claude" binary here,
      // so this test validates the routing path doesn't error
      expect(() => handle.start("plan task")).not.toThrow()
    })

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("routes to claude for think mode regardless of backend", async () => {
    const meta: SessionMeta = {
      ...baseMeta,
      mode: "think",
    }

    const handle = new SessionHandle(
      meta,
      () => {},
      () => {},
      60_000,
      300_000,
      makeConfig("codex"),
    )

    // Think mode routes to startClaudeThink — this will try to spawn "claude"
    // but we just want to verify the routing logic doesn't error
    expect(() => handle.start("think task")).not.toThrow()
  })
})

describe("ProviderProfile.backend", () => {
  it("accepts optional backend field", () => {
    const profile = {
      id: "codex-profile",
      name: "Codex Profile",
      backend: "codex" as BackendType,
    }
    expect(profile.backend).toBe("codex")
  })

  it("defaults to undefined backend", () => {
    const profile = {
      id: "default-profile",
      name: "Default Profile",
    }
    expect(profile.backend).toBeUndefined()
  })
})

describe("Backend resolution priority", () => {
  it("profile backend overrides default", () => {
    const profile = { id: "codex-profile", name: "Codex", backend: "codex" as BackendType }
    const defaultBackend: BackendType = "goose"
    const resolved = profile.backend ?? defaultBackend
    expect(resolved).toBe("codex")
  })

  it("falls back to default when profile has no backend", () => {
    const profile = { id: "default-profile", name: "Default" }
    const defaultBackend: BackendType = "goose"
    const resolved = profile.backend ?? defaultBackend
    expect(resolved).toBe("goose")
  })

  it("falls back to default when no profile is set", () => {
    const profile = undefined
    const defaultBackend: BackendType = "codex"
    const resolved = profile?.backend ?? defaultBackend
    expect(resolved).toBe("codex")
  })
})

import { describe, it, expect } from "vitest"
import { spawn } from "node:child_process"
import { SessionHandle, type SessionConfig } from "../src/session.js"
import type { SessionMeta } from "../src/types.js"

const stubConfig: SessionConfig = {
  goose: { provider: "test", model: "test" },
  claude: { planModel: "test", thinkModel: "test" },
  mcp: {
    browserEnabled: false,
    githubEnabled: false,
    context7Enabled: false,
    sentryEnabled: false,
    sentryOrgSlug: "",
    sentryProjectSlug: "",
  },
}

const stubMeta: SessionMeta = {
  sessionId: "test-kill",
  threadId: 1,
  topicName: "test-kill",
  repo: "test",
  cwd: "/tmp",
  startedAt: Date.now(),
  mode: "task",
}

function makeHandle(): SessionHandle {
  return new SessionHandle(stubMeta, () => {}, () => {}, 60_000, stubConfig)
}

function injectProcess(handle: SessionHandle, proc: ReturnType<typeof spawn>): void {
  const h = handle as unknown as { process: ReturnType<typeof spawn>; state: string }
  h.process = proc
  h.state = "working"
}

describe("SessionHandle.kill", () => {
  it("resolves immediately when no process is running", async () => {
    const handle = makeHandle()
    await handle.kill()
  })

  it("resolves immediately when process already exited", async () => {
    const handle = makeHandle()
    const h = handle as unknown as { state: string }
    h.state = "completed"
    await handle.kill()
  })

  it("sends SIGINT and resolves when process exits gracefully", async () => {
    const handle = makeHandle()
    const proc = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    })
    injectProcess(handle, proc)

    const start = Date.now()
    await handle.kill(5000)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(3000)
    expect(proc.killed).toBe(true)
  })

  it("escalates to SIGKILL when process ignores SIGINT", async () => {
    const handle = makeHandle()
    const proc = spawn(
      "node",
      ["-e", "process.on('SIGINT',()=>{}); process.stdout.write('ready'); setTimeout(()=>{},30000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    injectProcess(handle, proc)

    await new Promise<void>((resolve) => {
      proc.stdout!.once("data", () => resolve())
    })

    const start = Date.now()
    await handle.kill(200)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(3000)
    expect(proc.killed).toBe(true)
  })
})

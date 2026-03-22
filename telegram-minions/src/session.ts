import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { config } from "./config.js"
import type { GooseStreamEvent, SessionMeta, SessionState } from "./types.js"

export type SessionEventCallback = (event: GooseStreamEvent) => void
export type SessionDoneCallback = (meta: SessionMeta, state: "completed" | "errored") => void

export class SessionHandle {
  private process: ChildProcess | null = null
  private state: SessionState = "spawning"
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly meta: SessionMeta,
    private readonly onEvent: SessionEventCallback,
    private readonly onDone: SessionDoneCallback,
    private readonly timeoutMs: number,
  ) {}

  start(task: string): void {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      GOOSE_MODE: "auto",
      GOOSE_MAX_TURNS: "200",
      GOOSE_CONTEXT_STRATEGY: "summarize",
      GOOSE_TELEMETRY_ENABLED: "false",
      GOOSE_CLI_SHOW_COST: "false",
      CLAUDE_THINKING_TYPE: "enabled",
      CLAUDE_THINKING_BUDGET: "16000",
      HOME: process.env["HOME"] ?? "/root",
    }

    const systemPrompt = [
      "You are a coding minion running in a sandboxed environment.",
      "Your working directory is a fresh clone — local changes do not persist after this session ends.",
      "To deliver your work, you MUST:",
      "1. Create a new branch from the current HEAD",
      "2. Commit your changes to that branch",
      "3. Push the branch and open a pull request using `gh pr create`",
      "If you skip the PR, your work is lost.",
      "Use conventional commit messages. Keep PRs focused and well-described.",
      "The `gh` CLI is available and authenticated via GITHUB_TOKEN.",
    ].join("\n")

    this.process = spawn(
      "goose",
      [
        "run",
        "--text", task,
        "--output-format", "stream-json",
        "--name", this.meta.topicName,
        "--provider", config.goose.provider,
        "--model", config.goose.model,
        "--system", systemPrompt,
        "--no-profile",
        "--with-builtin", "developer",
        "--quiet",
      ],
      {
        cwd: this.meta.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    this.state = "working"

    const rl = createInterface({ input: this.process.stdout! })

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      try {
        const event = JSON.parse(trimmed) as GooseStreamEvent
        if (event.type === "complete") {
          this.meta.totalTokens = event.total_tokens ?? undefined
        }
        this.onEvent(event)
      } catch {
        process.stderr.write(`session ${this.meta.sessionId}: invalid JSON line: ${trimmed}\n`)
      }
    })

    this.process.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`session ${this.meta.sessionId} stderr: ${chunk.toString()}`)
    })

    this.process.on("close", (code) => {
      this.clearTimeout()
      const finalState: "completed" | "errored" = code === 0 ? "completed" : "errored"
      this.state = finalState
      this.onDone(this.meta, finalState)
    })

    this.process.on("error", (err) => {
      process.stderr.write(`session ${this.meta.sessionId}: process error: ${err}\n`)
      this.clearTimeout()
      this.state = "errored"
      this.onEvent({ type: "error", error: err.message })
      this.onDone(this.meta, "errored")
    })

    this.timeoutHandle = setTimeout(() => {
      process.stderr.write(`session ${this.meta.sessionId}: timeout after ${this.timeoutMs}ms\n`)
      this.interrupt()
    }, this.timeoutMs)
  }

  interrupt(): void {
    if (this.process && this.state === "working") {
      this.process.kill("SIGINT")
    }
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state === "spawning" || this.state === "working"
  }
}

/**
 * Scenario types and builder helpers for the mock agent binary.
 *
 * A scenario is a JSON file describing the sequence of NDJSON events
 * the mock agent should emit on stdout, with optional delays and exit code.
 */

import type { GooseStreamEvent } from "../../src/types.js"

// ── Scenario schema ──

export interface ScenarioStep {
  /** Milliseconds to wait before emitting this event (default: 0) */
  delay?: number
  /** The NDJSON event to emit */
  event: GooseStreamEvent
}

export interface Scenario {
  /** Ordered list of events to emit */
  steps: ScenarioStep[]
  /** Process exit code (default: 0) */
  exitCode?: number
  /** Optional stderr lines to emit before events start */
  stderr?: string[]
}

// ── Builder helpers ──

function now(): number {
  return Math.floor(Date.now() / 1000)
}

let toolIdCounter = 0
function nextToolId(): string {
  return `tool_${++toolIdCounter}`
}

/** Reset internal counters (useful between tests) */
export function resetBuilderState(): void {
  toolIdCounter = 0
}

/** Create a text message event from the assistant */
export function textMessage(text: string): GooseStreamEvent {
  return {
    type: "message",
    message: {
      role: "assistant",
      created: now(),
      content: [{ type: "text", text }],
    },
  }
}

/** Create a tool request event */
export function toolRequest(
  name: string,
  args: Record<string, unknown> = {},
): GooseStreamEvent {
  const id = nextToolId()
  return {
    type: "message",
    message: {
      role: "assistant",
      created: now(),
      content: [{ type: "toolRequest", id, toolCall: { name, arguments: args } }],
    },
  }
}

/** Create a tool response event */
export function toolResponse(
  id: string,
  result: unknown = "ok",
): GooseStreamEvent {
  return {
    type: "message",
    message: {
      role: "user",
      created: now(),
      content: [{ type: "toolResponse", id, toolResult: result }],
    },
  }
}

/** Create a completion event */
export function complete(totalTokens: number | null = 500): GooseStreamEvent {
  return { type: "complete", total_tokens: totalTokens }
}

/** Create an error event */
export function error(message: string): GooseStreamEvent {
  return { type: "error", error: message }
}

/** Create a notification event */
export function notification(
  extensionId: string,
  message: string,
): GooseStreamEvent {
  return { type: "notification", extensionId, message }
}

// ── Scenario builders for common patterns ──

/** A minimal successful session: one text message + complete */
export function simpleSuccess(text = "Task completed successfully."): Scenario {
  return {
    steps: [
      { event: textMessage(text) },
      { event: complete(500) },
    ],
    exitCode: 0,
  }
}

/** A session that uses a tool and completes */
export function withToolUse(
  toolName: string,
  toolArgs: Record<string, unknown> = {},
  toolResult: unknown = "ok",
  summary = "Done.",
): Scenario {
  const reqEvent = toolRequest(toolName, toolArgs)
  const reqContent = reqEvent.type === "message"
    ? reqEvent.message.content[0]
    : undefined
  const toolId = reqContent && "id" in reqContent ? reqContent.id : "tool_0"

  return {
    steps: [
      { event: textMessage("Working on it...") },
      { delay: 10, event: reqEvent },
      { delay: 10, event: toolResponse(toolId, toolResult) },
      { delay: 10, event: textMessage(summary) },
      { event: complete(1200) },
    ],
    exitCode: 0,
  }
}

/** A session that errors out */
export function failWithError(message = "Something went wrong"): Scenario {
  return {
    steps: [
      { event: textMessage("Starting...") },
      { delay: 10, event: error(message) },
    ],
    exitCode: 1,
  }
}

/** A multi-step session simulating a typical coding task */
export function codingTask(opts: {
  file?: string
  content?: string
  commitMessage?: string
} = {}): Scenario {
  const file = opts.file ?? "src/feature.ts"
  const content = opts.content ?? "export function feature() { return true }"
  const commitMsg = opts.commitMessage ?? "feat: add feature"

  const writeId = nextToolId()
  const bashId = nextToolId()

  return {
    steps: [
      { event: textMessage("I'll implement this feature.") },
      { delay: 10, event: {
        type: "message",
        message: {
          role: "assistant",
          created: now(),
          content: [{
            type: "toolRequest",
            id: writeId,
            toolCall: { name: "Write", arguments: { file_path: file, content } },
          }],
        },
      }},
      { delay: 10, event: toolResponse(writeId, { success: true }) },
      { delay: 10, event: {
        type: "message",
        message: {
          role: "assistant",
          created: now(),
          content: [{
            type: "toolRequest",
            id: bashId,
            toolCall: { name: "Bash", arguments: { command: `git add . && git commit -m "${commitMsg}"` } },
          }],
        },
      }},
      { delay: 10, event: toolResponse(bashId, { stdout: `[main abc1234] ${commitMsg}` }) },
      { delay: 10, event: textMessage("Feature implemented and committed.") },
      { event: complete(3000) },
    ],
    exitCode: 0,
  }
}

/** Build a custom scenario step-by-step */
export class ScenarioBuilder {
  private steps: ScenarioStep[] = []
  private _exitCode = 0
  private _stderr: string[] = []

  text(text: string, delay = 0): this {
    this.steps.push({ delay, event: textMessage(text) })
    return this
  }

  tool(name: string, args: Record<string, unknown> = {}, delay = 0): this {
    this.steps.push({ delay, event: toolRequest(name, args) })
    return this
  }

  toolResult(id: string, result: unknown = "ok", delay = 0): this {
    this.steps.push({ delay, event: toolResponse(id, result) })
    return this
  }

  err(message: string, delay = 0): this {
    this.steps.push({ delay, event: error(message) })
    return this
  }

  notify(extensionId: string, message: string, delay = 0): this {
    this.steps.push({ delay, event: notification(extensionId, message) })
    return this
  }

  done(totalTokens: number | null = 500): this {
    this.steps.push({ event: complete(totalTokens) })
    return this
  }

  exitCode(code: number): this {
    this._exitCode = code
    return this
  }

  stderr(line: string): this {
    this._stderr.push(line)
    return this
  }

  build(): Scenario {
    return {
      steps: this.steps,
      exitCode: this._exitCode,
      ...(this._stderr.length > 0 ? { stderr: this._stderr } : {}),
    }
  }
}

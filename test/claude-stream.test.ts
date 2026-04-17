import { describe, it, expect } from "vitest"
import { translateClaudeEvent, translateClaudeEvents } from "../src/session/claude-stream.js"

describe("translateClaudeEvent", () => {
  it("translates a text delta stream event", () => {
    const result = translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      expect(result!.message.role).toBe("assistant")
      expect(result!.message.content).toHaveLength(1)
      expect(result!.message.content[0]).toEqual({ type: "text", text: "hello" })
    }
  })

  it("returns null for stream events without text delta", () => {
    expect(translateClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_start" },
    })).toBeNull()
  })

  it("returns null for stream events without event", () => {
    expect(translateClaudeEvent({ type: "stream_event" })).toBeNull()
  })

  it("translates an assistant message with tool_use blocks", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("message")
    if (result!.type === "message") {
      const block = result!.message.content[0]
      expect(block.type).toBe("toolRequest")
      if (block.type === "toolRequest") {
        expect(block.toolCall).toEqual({ name: "Bash", arguments: { command: "ls" } })
      }
    }
  })

  it("returns null for assistant messages with no tool_use blocks", () => {
    const result = translateClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    })
    expect(result).toBeNull()
  })

  it("returns null for non-assistant messages", () => {
    expect(translateClaudeEvent({
      type: "assistant",
      message: { role: "user", content: [] },
    })).toBeNull()
  })

  it("translates a successful result event", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    expect(result).toEqual({ type: "complete", total_tokens: 150 })
  })

  it("translates a result with no usage to null total_tokens", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "done",
      is_error: false,
    })
    expect(result).toEqual({ type: "complete", total_tokens: null })
  })

  it("translates an error result", () => {
    const result = translateClaudeEvent({
      type: "result",
      result: "something went wrong",
      is_error: true,
    })
    expect(result).toEqual({ type: "error", error: "something went wrong" })
  })

  it("translates an error result with no result text", () => {
    const result = translateClaudeEvent({
      type: "result",
      is_error: true,
    })
    expect(result).toEqual({ type: "error", error: "Unknown error" })
  })

  it("returns null for unknown event types", () => {
    expect(translateClaudeEvent({ type: "ping" })).toBeNull()
  })
})

describe("translateClaudeEvents", () => {
  it("translates multiple tool_use blocks from an assistant message", () => {
    const events = translateClaudeEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
        ],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("message")
    expect(events[1].type).toBe("message")
  })

  it("returns empty array for non-assistant messages", () => {
    expect(translateClaudeEvents({
      type: "assistant",
      message: { role: "user", content: [] },
    })).toEqual([])
  })

  it("wraps single event from translateClaudeEvent into array", () => {
    const events = translateClaudeEvents({
      type: "result",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    expect(events).toEqual([{ type: "complete", total_tokens: 30 }])
  })

  it("returns empty array for null-producing events", () => {
    const events = translateClaudeEvents({ type: "ping" })
    expect(events).toEqual([])
  })

  it("translates user message with tool_result blocks into toolResponse events", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "tr-1", content: "file contents here" },
          { type: "tool_result", id: "tr-2", input: { key: "value" } },
        ],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("message")
    if (events[0].type === "message") {
      expect(events[0].message.role).toBe("user")
      const block = events[0].message.content[0]
      expect(block.type).toBe("toolResponse")
      if (block.type === "toolResponse") {
        expect(block.id).toBe("tr-1")
        expect(block.toolResult).toBe("file contents here")
      }
    }
    if (events[1].type === "message") {
      const block = events[1].message.content[0]
      if (block.type === "toolResponse") {
        expect(block.id).toBe("tr-2")
        expect(block.toolResult).toEqual({ key: "value" })
      }
    }
  })

  it("returns empty array for user message with no tool_result blocks", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "just text" }],
      },
    })
    expect(events).toEqual([])
  })

  it("returns empty array for user message with wrong role", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: { role: "assistant", content: [] },
    })
    expect(events).toEqual([])
  })

  it("returns empty array for user message with no message", () => {
    const events = translateClaudeEvents({ type: "user" })
    expect(events).toEqual([])
  })

  it("handles tool_result with null content falling back to input", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "tr-3", input: { fallback: true } },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      const block = events[0].message.content[0]
      if (block.type === "toolResponse") {
        expect(block.toolResult).toEqual({ fallback: true })
      }
    }
  })

  it("handles tool_result with neither content nor input", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", id: "tr-4" },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      const block = events[0].message.content[0]
      if (block.type === "toolResponse") {
        expect(block.toolResult).toBeNull()
      }
    }
  })

  it("handles tool_result with missing id", () => {
    const events = translateClaudeEvents({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: "result data" },
        ],
      },
    })

    expect(events).toHaveLength(1)
    if (events[0].type === "message") {
      const block = events[0].message.content[0]
      if (block.type === "toolResponse") {
        expect(block.id).toBe("")
        expect(block.toolResult).toBe("result data")
      }
    }
  })
})

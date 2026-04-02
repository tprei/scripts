import { describe, it, expect } from "vitest"
import { buildConversationText, MAX_ASSISTANT_CHARS } from "../src/claude-extract.js"
import type { TopicMessage } from "../src/domain/session-types.js"
describe("buildConversationText", () => {
  it("formats a simple conversation", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
    ]
    const result = buildConversationText(conversation)
    expect(result).toContain("**User**:\nHello")
    expect(result).toContain("**Agent**:\nHi there")
    expect(result).toContain("## Conversation")
  })

  it("does not truncate short assistant messages", () => {
    const text = "a".repeat(MAX_ASSISTANT_CHARS)
    const conversation: TopicMessage[] = [
      { role: "assistant", text },
    ]
    const result = buildConversationText(conversation)
    expect(result).not.toContain("[earlier output truncated]")
    expect(result).toContain(text)
  })

  it("truncates assistant messages exceeding default limit", () => {
    const text = "a".repeat(MAX_ASSISTANT_CHARS + 1000)
    const conversation: TopicMessage[] = [
      { role: "assistant", text },
    ]
    const result = buildConversationText(conversation)
    expect(result).toContain("[earlier output truncated]")
    // Keeps the trailing MAX_ASSISTANT_CHARS characters
    expect(result).toContain("a".repeat(MAX_ASSISTANT_CHARS))
    // Does not contain the full text
    expect(result).not.toContain(text)
  })

  it("never truncates user messages", () => {
    const text = "u".repeat(MAX_ASSISTANT_CHARS + 5000)
    const conversation: TopicMessage[] = [
      { role: "user", text },
    ]
    const result = buildConversationText(conversation)
    expect(result).not.toContain("[earlier output truncated]")
    expect(result).toContain(text)
  })

  it("accepts a custom maxAssistantChars value", () => {
    const text = "b".repeat(6000)
    const conversation: TopicMessage[] = [
      { role: "assistant", text },
    ]

    // With default (4000), should truncate
    const defaultResult = buildConversationText(conversation)
    expect(defaultResult).toContain("[earlier output truncated]")

    // With higher limit (8000), should not truncate
    const wideResult = buildConversationText(conversation, undefined, 8000)
    expect(wideResult).not.toContain("[earlier output truncated]")
    expect(wideResult).toContain(text)
  })

  it("truncates at custom limit when exceeded", () => {
    const text = "c".repeat(10000)
    const conversation: TopicMessage[] = [
      { role: "assistant", text },
    ]
    const result = buildConversationText(conversation, undefined, 8000)
    expect(result).toContain("[earlier output truncated]")
    // Should contain exactly the trailing 8000 chars
    expect(result).toContain("c".repeat(8000))
  })

  it("preserves trailing content during truncation", () => {
    // Build a message where the tail is distinguishable from the head
    const head = "HEAD".repeat(2000)
    const tail = "TAIL".repeat(1000)
    const text = head + tail
    const conversation: TopicMessage[] = [
      { role: "assistant", text },
    ]
    const result = buildConversationText(conversation, undefined, tail.length)
    expect(result).toContain("[earlier output truncated]")
    expect(result).toContain(tail)
    expect(result).not.toContain("HEADHEAD") // head is removed
  })

  it("appends directive section when provided", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Do something" },
    ]
    const result = buildConversationText(conversation, "Focus on backend items only")
    expect(result).toContain("## Directive")
    expect(result).toContain("Focus on backend items only")
  })

  it("omits directive section when not provided", () => {
    const conversation: TopicMessage[] = [
      { role: "user", text: "Do something" },
    ]
    const result = buildConversationText(conversation)
    expect(result).not.toContain("## Directive")
  })

  it("exports MAX_ASSISTANT_CHARS as 4000", () => {
    expect(MAX_ASSISTANT_CHARS).toBe(4000)
  })
})

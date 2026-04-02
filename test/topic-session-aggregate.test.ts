import { describe, it, expect, beforeEach } from "vitest"
import { TopicSessionAggregate } from "../src/domain/topic-session.js"
import type { TopicSession, TopicMessage, AutoAdvance } from "../src/types.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "test-repo",
    cwd: "/tmp/test",
    slug: "test-slug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: 1000,
    ...overrides,
  }
}

function makeMessage(role: "user" | "assistant", text: string): TopicMessage {
  return { role, text }
}

describe("TopicSessionAggregate", () => {
  let agg: TopicSessionAggregate

  beforeEach(() => {
    agg = new TopicSessionAggregate(makeSession())
  })

  describe("constructor", () => {
    it("copies all fields from plain TopicSession", () => {
      const data = makeSession({
        repoUrl: "https://github.com/org/repo",
        conversation: [makeMessage("user", "hello")],
        pendingFeedback: ["feedback1"],
        childThreadIds: [2, 3],
        autoAdvance: { phase: "think", featureDescription: "feat", autoLand: false },
      })

      const session = new TopicSessionAggregate(data)

      expect(session.threadId).toBe(1)
      expect(session.repo).toBe("test-repo")
      expect(session.repoUrl).toBe("https://github.com/org/repo")
      expect(session.conversation).toEqual([makeMessage("user", "hello")])
      expect(session.pendingFeedback).toEqual(["feedback1"])
      expect(session.childThreadIds).toEqual([2, 3])
      expect(session.autoAdvance).toEqual({ phase: "think", featureDescription: "feat", autoLand: false })
    })

    it("creates defensive copies of arrays", () => {
      const conversation = [makeMessage("user", "hello")]
      const feedback = ["fb"]
      const children = [2]
      const data = makeSession({ conversation, pendingFeedback: feedback, childThreadIds: children })

      const session = new TopicSessionAggregate(data)

      expect(session.conversation).not.toBe(conversation)
      expect(session.pendingFeedback).not.toBe(feedback)
      expect(session.childThreadIds).not.toBe(children)
    })
  })

  describe("pushMessage", () => {
    it("appends a message to conversation", () => {
      agg.pushMessage(makeMessage("user", "hello"), 100)
      expect(agg.conversation).toHaveLength(1)
      expect(agg.conversation[0]).toEqual(makeMessage("user", "hello"))
    })

    it("truncates when conversation exceeds maxLength", () => {
      for (let i = 0; i < 5; i++) {
        agg.pushMessage(makeMessage("user", `msg ${i}`), 100)
      }
      expect(agg.conversation).toHaveLength(5)

      // Now push enough to exceed a small maxLength
      const smallMax = 3
      for (let i = 0; i < 5; i++) {
        agg.pushMessage(makeMessage("assistant", `reply ${i}`), smallMax)
      }
      expect(agg.conversation.length).toBeLessThanOrEqual(smallMax)
    })

    it("updates lastActivityAt", () => {
      const before = agg.lastActivityAt
      agg.pushMessage(makeMessage("user", "test"), 100)
      expect(agg.lastActivityAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe("markCompleted", () => {
    it("sets lastState to completed and clears activeSessionId", () => {
      agg.activeSessionId = "abc"
      agg.markCompleted()
      expect(agg.lastState).toBe("completed")
      expect(agg.activeSessionId).toBeUndefined()
    })

    it("records prUrl when provided", () => {
      agg.markCompleted("https://github.com/org/repo/pull/1")
      expect(agg.prUrl).toBe("https://github.com/org/repo/pull/1")
    })

    it("does not overwrite prUrl when not provided", () => {
      agg.prUrl = "existing"
      agg.markCompleted()
      expect(agg.prUrl).toBe("existing")
    })
  })

  describe("markErrored", () => {
    it("sets lastState to errored and clears activeSessionId", () => {
      agg.activeSessionId = "abc"
      agg.markErrored()
      expect(agg.lastState).toBe("errored")
      expect(agg.activeSessionId).toBeUndefined()
    })
  })

  describe("markQuotaExhausted", () => {
    it("sets lastState and increments retry count", () => {
      agg.markQuotaExhausted()
      expect(agg.lastState).toBe("quota_exhausted")
      expect(agg.quotaRetryCount).toBe(1)
    })

    it("increments existing retry count", () => {
      agg.quotaRetryCount = 2
      agg.markQuotaExhausted()
      expect(agg.quotaRetryCount).toBe(3)
    })

    it("sets sleepUntil when provided", () => {
      const sleepUntil = Date.now() + 60_000
      agg.markQuotaExhausted(sleepUntil)
      expect(agg.quotaSleepUntil).toBe(sleepUntil)
    })
  })

  describe("clearQuotaSleep", () => {
    it("clears all quota-related state", () => {
      agg.lastState = "quota_exhausted"
      agg.quotaRetryCount = 3
      agg.quotaSleepUntil = Date.now() + 60_000
      agg.clearQuotaSleep()
      expect(agg.lastState).toBeUndefined()
      expect(agg.quotaRetryCount).toBeUndefined()
      expect(agg.quotaSleepUntil).toBeUndefined()
    })
  })

  describe("addChild / removeChild", () => {
    it("initializes childThreadIds if undefined", () => {
      expect(agg.childThreadIds).toBeUndefined()
      agg.addChild(10)
      expect(agg.childThreadIds).toEqual([10])
    })

    it("appends to existing children", () => {
      agg.childThreadIds = [5]
      agg.addChild(10)
      expect(agg.childThreadIds).toEqual([5, 10])
    })

    it("removes an existing child and returns true", () => {
      agg.childThreadIds = [5, 10, 15]
      const removed = agg.removeChild(10)
      expect(removed).toBe(true)
      expect(agg.childThreadIds).toEqual([5, 15])
    })

    it("returns false when child not found", () => {
      agg.childThreadIds = [5]
      expect(agg.removeChild(99)).toBe(false)
    })

    it("returns false when childThreadIds is undefined", () => {
      expect(agg.removeChild(1)).toBe(false)
    })
  })

  describe("setAutoAdvance", () => {
    it("sets auto-advance config", () => {
      const config: AutoAdvance = { phase: "plan", featureDescription: "feat", autoLand: true }
      agg.setAutoAdvance(config)
      expect(agg.autoAdvance).toEqual(config)
    })

    it("creates a defensive copy", () => {
      const config: AutoAdvance = { phase: "plan", featureDescription: "feat", autoLand: true }
      agg.setAutoAdvance(config)
      config.phase = "done"
      expect(agg.autoAdvance!.phase).toBe("plan")
    })

    it("clears when set to undefined", () => {
      agg.autoAdvance = { phase: "think", featureDescription: "feat", autoLand: false }
      agg.setAutoAdvance(undefined)
      expect(agg.autoAdvance).toBeUndefined()
    })
  })

  describe("queueFeedback / drainFeedback", () => {
    it("queues feedback messages", () => {
      agg.queueFeedback("first")
      agg.queueFeedback("second")
      expect(agg.pendingFeedback).toEqual(["first", "second"])
    })

    it("drains feedback joining with double newline", () => {
      agg.queueFeedback("first")
      agg.queueFeedback("second")
      const drained = agg.drainFeedback()
      expect(drained).toBe("first\n\nsecond")
      expect(agg.pendingFeedback).toEqual([])
    })

    it("returns empty string when no feedback", () => {
      expect(agg.drainFeedback()).toBe("")
    })
  })

  describe("activate / deactivate / isActive", () => {
    it("activates with session ID", () => {
      agg.activate("session-123")
      expect(agg.activeSessionId).toBe("session-123")
      expect(agg.isActive).toBe(true)
    })

    it("deactivates", () => {
      agg.activate("session-123")
      agg.deactivate()
      expect(agg.activeSessionId).toBeUndefined()
      expect(agg.isActive).toBe(false)
    })
  })

  describe("toJSON / fromJSON", () => {
    it("round-trips through serialization", () => {
      const data = makeSession({
        repoUrl: "https://github.com/org/repo",
        conversation: [makeMessage("user", "hello"), makeMessage("assistant", "hi")],
        pendingFeedback: ["fb1"],
        childThreadIds: [2, 3],
        branch: "minion/test",
        prUrl: "https://github.com/org/repo/pull/1",
        lastState: "completed",
        autoAdvance: { phase: "dag", featureDescription: "feat", autoLand: true },
      })

      const original = TopicSessionAggregate.fromJSON(data)
      const serialized = original.toJSON()
      const restored = TopicSessionAggregate.fromJSON(serialized)

      expect(restored.toJSON()).toEqual(original.toJSON())
    })

    it("toJSON returns a plain object matching TopicSession interface", () => {
      agg.pushMessage(makeMessage("user", "test"), 100)
      agg.activate("s1")
      const json = agg.toJSON()

      expect(json.threadId).toBe(1)
      expect(json.conversation).toHaveLength(1)
      expect(json.activeSessionId).toBe("s1")
      expect(typeof json).toBe("object")
      expect(json).not.toBeInstanceOf(TopicSessionAggregate)
    })

    it("fromJSON creates a functional aggregate", () => {
      const data = makeSession({ quotaRetryCount: 1 })
      const restored = TopicSessionAggregate.fromJSON(data)
      restored.markQuotaExhausted()
      expect(restored.quotaRetryCount).toBe(2)
    })

    it("survives JSON.stringify/parse round-trip", () => {
      const data = makeSession({
        conversation: [makeMessage("user", "hello")],
        childThreadIds: [2],
        autoAdvance: { phase: "think", featureDescription: "f", autoLand: false },
      })
      const original = new TopicSessionAggregate(data)
      const jsonStr = JSON.stringify(original.toJSON())
      const parsed = JSON.parse(jsonStr) as TopicSession
      const restored = TopicSessionAggregate.fromJSON(parsed)
      expect(restored.toJSON()).toEqual(original.toJSON())
    })
  })
})

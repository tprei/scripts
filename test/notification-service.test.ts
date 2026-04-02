import { describe, it, expect, vi } from "vitest"
import { createNotificationService } from "../src/application/notification-service.js"
import type { NotificationDeps } from "../src/application/notification-service.js"
import type { TopicSession } from "../src/types.js"
import type { DagGraph } from "../src/dag/dag.js"

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 1,
    repo: "test-repo",
    slug: "bold-fox",
    conversation: [{ role: "user", text: "fix the tests" }],
    activeSessionId: "abc",
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    cwd: "/tmp/workspace/bold-fox",
    ...overrides,
  }
}

function makeDeps(overrides: Partial<NotificationDeps> = {}): NotificationDeps {
  return {
    chatId: "123",
    topicSessions: new Map(),
    sessions: new Map(),
    pinnedMessages: {
      updatePinnedSummary: vi.fn(),
      updateTopicTitle: vi.fn().mockResolvedValue(undefined),
      pinThreadMessage: vi.fn().mockResolvedValue(undefined),
      updatePinnedSplitStatus: vi.fn().mockResolvedValue(undefined),
      updatePinnedDagStatus: vi.fn().mockResolvedValue(undefined),
    } as any,
    broadcaster: {
      broadcast: vi.fn(),
    } as any,
    ...overrides,
  }
}

describe("NotificationService", () => {
  describe("broadcastSession", () => {
    it("broadcasts a session_created event", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const session = makeSession()

      svc.broadcastSession(session, "session_created")

      expect(deps.broadcaster!.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_created" }),
      )
    })

    it("broadcasts a session_updated event with session state", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const session = makeSession()

      svc.broadcastSession(session, "session_updated", "completed")

      const call = vi.mocked(deps.broadcaster!.broadcast).mock.calls[0][0]
      expect(call.type).toBe("session_updated")
      expect((call as any).session.status).toBe("completed")
    })

    it("no-ops when broadcaster is undefined", () => {
      const deps = makeDeps({ broadcaster: undefined })
      const svc = createNotificationService(deps)

      expect(() => svc.broadcastSession(makeSession(), "session_created")).not.toThrow()
    })
  })

  describe("broadcastSessionDeleted", () => {
    it("broadcasts a session_deleted event", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)

      svc.broadcastSessionDeleted("bold-fox")

      expect(deps.broadcaster!.broadcast).toHaveBeenCalledWith({
        type: "session_deleted",
        sessionId: "bold-fox",
      })
    })

    it("no-ops when broadcaster is undefined", () => {
      const deps = makeDeps({ broadcaster: undefined })
      const svc = createNotificationService(deps)

      expect(() => svc.broadcastSessionDeleted("bold-fox")).not.toThrow()
    })
  })

  describe("broadcastDag", () => {
    it("broadcasts a dag_created event", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        isStack: false,
        createdAt: Date.now(),
        nodes: [],
      }

      svc.broadcastDag(graph, "dag_created")

      expect(deps.broadcaster!.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dag_created" }),
      )
    })

    it("no-ops when broadcaster is undefined", () => {
      const deps = makeDeps({ broadcaster: undefined })
      const svc = createNotificationService(deps)
      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        isStack: false,
        createdAt: Date.now(),
        nodes: [],
      }

      expect(() => svc.broadcastDag(graph, "dag_created")).not.toThrow()
    })
  })

  describe("broadcastDagDeleted", () => {
    it("broadcasts a dag_deleted event", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)

      svc.broadcastDagDeleted("dag-1")

      expect(deps.broadcaster!.broadcast).toHaveBeenCalledWith({
        type: "dag_deleted",
        dagId: "dag-1",
      })
    })

    it("no-ops when broadcaster is undefined", () => {
      const deps = makeDeps({ broadcaster: undefined })
      const svc = createNotificationService(deps)

      expect(() => svc.broadcastDagDeleted("dag-1")).not.toThrow()
    })
  })

  describe("pinned message delegation", () => {
    it("delegates updatePinnedSummary to PinnedMessageManager", () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)

      svc.updatePinnedSummary()

      expect(deps.pinnedMessages.updatePinnedSummary).toHaveBeenCalled()
    })

    it("delegates updateTopicTitle to PinnedMessageManager", async () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const session = makeSession()

      await svc.updateTopicTitle(session, "⚡")

      expect(deps.pinnedMessages.updateTopicTitle).toHaveBeenCalledWith(session, "⚡")
    })

    it("delegates pinThreadMessage to PinnedMessageManager", async () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const session = makeSession()

      await svc.pinThreadMessage(session, "<b>Hello</b>")

      expect(deps.pinnedMessages.pinThreadMessage).toHaveBeenCalledWith(session, "<b>Hello</b>")
    })

    it("delegates updatePinnedSplitStatus to PinnedMessageManager", async () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const parent = makeSession({ childThreadIds: [2, 3] })

      await svc.updatePinnedSplitStatus(parent)

      expect(deps.pinnedMessages.updatePinnedSplitStatus).toHaveBeenCalledWith(parent)
    })

    it("delegates updatePinnedDagStatus to PinnedMessageManager", async () => {
      const deps = makeDeps()
      const svc = createNotificationService(deps)
      const parent = makeSession()
      const graph: DagGraph = {
        id: "dag-1",
        parentThreadId: 1,
        isStack: false,
        createdAt: Date.now(),
        nodes: [],
      }

      await svc.updatePinnedDagStatus(parent, graph)

      expect(deps.pinnedMessages.updatePinnedDagStatus).toHaveBeenCalledWith(parent, graph)
    })
  })
})

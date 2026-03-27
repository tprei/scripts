import { describe, it, expect, vi, beforeEach } from "vitest"
import { DagOrchestrator, type DagOrchestratorCallbacks, type DagOrchestratorConfig } from "../src/dag-orchestrator.js"
import type { DagGraph, DagNode, DagInput } from "../src/dag.js"
import type { TopicSession } from "../src/types.js"
import type { ActiveSession } from "../src/session-manager.js"
import type { TelegramClient } from "../src/telegram.js"
import type { ProfileStore } from "../src/profile-store.js"

// Mock Telegram client
const mockTelegram = {
  sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
  createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 123 }),
  deleteForumTopic: vi.fn().mockResolvedValue(undefined),
} as unknown as TelegramClient

// Mock ProfileStore
const mockProfileStore = {
  get: vi.fn().mockReturnValue(undefined),
} as unknown as ProfileStore

// Mock callbacks
const createMockCallbacks = (): DagOrchestratorCallbacks => ({
  getActiveSession: vi.fn().mockReturnValue(undefined),
  deleteActiveSession: vi.fn(),
  getTopicSession: vi.fn().mockReturnValue(undefined),
  setTopicSession: vi.fn(),
  deleteTopicSession: vi.fn(),
  getAllTopicSessions: vi.fn().mockReturnValue([][Symbol.iterator]()),
  getActiveSessionCount: vi.fn().mockReturnValue(0),
  spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
  prepareWorkspace: vi.fn().mockResolvedValue("/tmp/workspace"),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  prepareFanInBranch: vi.fn().mockResolvedValue("fan-in-branch"),
  mergeUpstreamBranches: vi.fn().mockReturnValue(true),
  closeChildSessions: vi.fn().mockResolvedValue(undefined),
  updateTopicTitle: vi.fn().mockResolvedValue(undefined),
  extractPRFromConversation: vi.fn().mockReturnValue(null),
  updatePinnedDagStatus: vi.fn().mockResolvedValue(undefined),
  updatePinnedSplitStatus: vi.fn().mockResolvedValue(undefined),
  persistTopicSessions: vi.fn().mockResolvedValue(undefined),
  runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
  broadcastSession: vi.fn(),
  broadcastSessionDeleted: vi.fn(),
  handleExecuteCommand: vi.fn().mockResolvedValue(undefined),
})

// Test config
const testConfig: DagOrchestratorConfig = {
  workspaceRoot: "/tmp/workspace",
  maxConcurrentSessions: 10,
  maxDagConcurrency: 5,
}

describe("DagOrchestrator", () => {
  let orchestrator: DagOrchestrator
  let callbacks: DagOrchestratorCallbacks

  beforeEach(() => {
    vi.clearAllMocks()
    callbacks = createMockCallbacks()
    orchestrator = new DagOrchestrator(
      mockTelegram,
      mockProfileStore,
      testConfig,
      callbacks,
      undefined,
    )
  })

  describe("getDags", () => {
    it("returns empty map initially", () => {
      const dags = orchestrator.getDags()
      expect(dags.size).toBe(0)
    })
  })

  describe("getDag", () => {
    it("returns undefined for non-existent DAG", () => {
      expect(orchestrator.getDag("non-existent")).toBeUndefined()
    })
  })

  describe("deleteDag", () => {
    it("removes a DAG from the map", () => {
      // First, add a DAG manually
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [],
        parentThreadId: 1,
        repo: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: Date.now(),
      }
      orchestrator.getDags().set("test-dag", graph)

      expect(orchestrator.getDag("test-dag")).toBeDefined()

      orchestrator.deleteDag("test-dag")

      expect(orchestrator.getDag("test-dag")).toBeUndefined()
    })
  })

  describe("isDagComplete", () => {
    it("returns true when all nodes are done", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "done" },
          { id: "b", title: "B", description: "", dependsOn: ["a"], status: "done" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isDagComplete(graph)).toBe(true)
    })

    it("returns false when some nodes are pending", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "done" },
          { id: "b", title: "B", description: "", dependsOn: ["a"], status: "pending" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isDagComplete(graph)).toBe(false)
    })

    it("returns true when nodes are done, failed, or skipped", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "done" },
          { id: "b", title: "B", description: "", dependsOn: ["a"], status: "failed" },
          { id: "c", title: "C", description: "", dependsOn: ["b"], status: "skipped" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isDagComplete(graph)).toBe(true)
    })
  })

  describe("isStack", () => {
    it("returns true for linear DAG (stack)", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "pending" },
          { id: "b", title: "B", description: "", dependsOn: ["a"], status: "pending" },
          { id: "c", title: "C", description: "", dependsOn: ["b"], status: "pending" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isStack(graph)).toBe(true)
    })

    it("returns false for DAG with fan-in", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "pending" },
          { id: "b", title: "B", description: "", dependsOn: [], status: "pending" },
          { id: "c", title: "C", description: "", dependsOn: ["a", "b"], status: "pending" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isStack(graph)).toBe(false)
    })

    it("returns true for single node DAG", () => {
      const graph: DagGraph = {
        id: "test-dag",
        nodes: [
          { id: "a", title: "A", description: "", dependsOn: [], status: "pending" },
        ],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      expect(orchestrator.isStack(graph)).toBe(true)
    })
  })

  describe("updatePinnedDagStatus", () => {
    it("calls the callback to update pinned status", async () => {
      const parent: TopicSession = {
        threadId: 1,
        repo: "test-repo",
        cwd: "/tmp/test",
        slug: "test-slug",
        conversation: [],
        pendingFeedback: [],
        mode: "task",
        lastActivityAt: Date.now(),
      }

      const graph: DagGraph = {
        id: "test-dag",
        nodes: [],
        parentThreadId: 1,
        repo: "test-repo",
        createdAt: Date.now(),
      }

      await orchestrator.updatePinnedDagStatus(parent, graph)

      expect(callbacks.updatePinnedDagStatus).toHaveBeenCalledWith(parent, graph)
    })
  })
})

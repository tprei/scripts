import { describe, it, expect, vi, beforeEach } from "vitest"
import { SessionLifecycle } from "../src/orchestration/session-lifecycle.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TopicSession, SessionMeta } from "../src/types.js"

vi.mock("../src/session/session.js", () => {
  const SessionHandle = vi.fn(function(this: any) {
    this.start = vi.fn()
    this.interrupt = vi.fn()
  })
  return { SessionHandle }
})

vi.mock("../src/ci/quality-gates.js", () => ({
  runQualityGates: vi.fn().mockReturnValue({ allPassed: true, results: [] }),
}))

vi.mock("../src/session/session-log.js", () => ({
  writeSessionLog: vi.fn(),
}))

vi.mock("../src/sentry.js", () => ({
  captureException: vi.fn(),
}))

function makeSession(overrides: Partial<TopicSession> = {}): TopicSession {
  return {
    threadId: 100,
    repo: "org/repo",
    cwd: "/tmp/workspace",
    slug: "test-slug",
    topicHandle: "test-slug/fix-bug",
    conversation: [],
    pendingFeedback: [],
    mode: "task",
    lastActivityAt: Date.now(),
    ...overrides,
  }
}

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "session-123",
    threadId: 100,
    topicName: "test-slug/fix-bug",
    repo: "org/repo",
    cwd: "/tmp/workspace",
    startedAt: Date.now() - 5000,
    mode: "task",
    ...overrides,
  }
}

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      workspace: {
        root: "/tmp/test",
        maxConcurrentSessions: 5,
        sessionTokenBudget: 100000,
        sessionTimeoutMs: 300000,
        sessionInactivityTimeoutMs: 60000,
        maxConversationLength: 50,
      },
      ci: { babysitEnabled: false, maxRetries: 2, pollIntervalMs: 5000, pollTimeoutMs: 300000, dagCiPolicy: "skip" },
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test", reviewModel: "test" },
      mcp: {
        browserEnabled: false,
        githubEnabled: false,
        context7Enabled: false,
        sentryEnabled: false,
        sentryOrgSlug: "",
        sentryProjectSlug: "",
        supabaseEnabled: false,
        supabaseProjectRef: "",
        zaiEnabled: false,
      },
    } as any,
    telegram: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 200 }),
      deleteForumTopic: vi.fn().mockResolvedValue(undefined),
    } as any,
    observer: {
      onEvent: vi.fn().mockResolvedValue(undefined),
      onSessionStart: vi.fn().mockResolvedValue(undefined),
      onSessionComplete: vi.fn().mockResolvedValue(undefined),
      flushAndComplete: vi.fn().mockResolvedValue(undefined),
    } as any,
    stats: {
      record: vi.fn().mockResolvedValue(undefined),
    } as any,
    profileStore: {
      get: vi.fn().mockReturnValue(undefined),
    } as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    refreshGitToken: vi.fn().mockResolvedValue(undefined),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockResolvedValue(undefined),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/workspace"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanBuildArtifacts: vi.fn(),
    prepareFanInBranch: vi.fn().mockResolvedValue(null),
    mergeUpstreamBranches: vi.fn().mockReturnValue({ ok: true, conflictFiles: [] }),
    downloadPhotos: vi.fn().mockResolvedValue([]),
    pushToConversation: vi.fn(),
    extractPRFromConversation: vi.fn().mockReturnValue(null),
    persistTopicSessions: vi.fn().mockResolvedValue(undefined),
    persistDags: vi.fn().mockResolvedValue(undefined),
    updatePinnedSummary: vi.fn(),
    updateTopicTitle: vi.fn().mockResolvedValue(undefined),
    pinThreadMessage: vi.fn().mockResolvedValue(undefined),
    updatePinnedSplitStatus: vi.fn().mockResolvedValue(undefined),
    updatePinnedDagStatus: vi.fn().mockResolvedValue(undefined),
    broadcastSession: vi.fn(),
    broadcastSessionDeleted: vi.fn(),
    broadcastDag: vi.fn(),
    broadcastDagDeleted: vi.fn(),
    closeChildSessions: vi.fn().mockResolvedValue(undefined),
    closeSingleChild: vi.fn().mockResolvedValue(undefined),
    startDag: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToVerification: vi.fn().mockResolvedValue(undefined),
    handleLandCommand: vi.fn().mockResolvedValue(undefined),
    handleShipAdvance: vi.fn().mockResolvedValue(undefined),
    shipAdvanceToDag: vi.fn().mockResolvedValue(undefined),
    handleExecuteCommand: vi.fn().mockResolvedValue(undefined),
    notifyParentOfChildComplete: vi.fn().mockResolvedValue(undefined),
    handleTopicFeedback: vi.fn().mockResolvedValue(undefined),
    postSessionDigest: vi.fn(),
    runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
    queueDeferredBabysit: vi.fn(),
    babysitPR: vi.fn().mockResolvedValue(undefined),
    babysitDagChildCI: vi.fn().mockResolvedValue(true),
    updateDagPRDescriptions: vi.fn().mockResolvedValue(undefined),
    scheduleDagNodes: vi.fn().mockResolvedValue(undefined),
    spawnSplitChild: vi.fn().mockResolvedValue(null),
    spawnDagChild: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

describe("SessionLifecycle", () => {
  let ctx: DispatcherContext
  let lifecycle: SessionLifecycle

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeContext()
    lifecycle = new SessionLifecycle(ctx)
  })

  describe("startTopicSession", () => {
    it("creates a topic, prepares workspace, and spawns agent", async () => {
      const { SessionHandle } = await import("../src/session/session.js")
      const mockHandle = vi.mocked(SessionHandle)

      await lifecycle.startTopicSession("https://github.com/org/repo", "Fix the bug", "task")

      expect(ctx.telegram.createForumTopic).toHaveBeenCalledWith(expect.stringContaining("/"))
      expect(ctx.prepareWorkspace).toHaveBeenCalled()
      expect(ctx.topicSessions.size).toBe(1)
      expect(ctx.broadcastSession).toHaveBeenCalledWith(expect.any(Object), "session_created")
      expect(ctx.updatePinnedSummary).toHaveBeenCalled()
      expect(mockHandle).toHaveBeenCalled()
    })

    it("returns early if topic creation fails", async () => {
      vi.mocked(ctx.telegram.createForumTopic).mockRejectedValueOnce(new Error("topic error"))

      await lifecycle.startTopicSession("https://github.com/org/repo", "Fix the bug", "task")

      expect(ctx.prepareWorkspace).not.toHaveBeenCalled()
      expect(ctx.topicSessions.size).toBe(0)
    })

    it("cleans up if workspace preparation fails", async () => {
      vi.mocked(ctx.prepareWorkspace).mockResolvedValueOnce(null)

      await lifecycle.startTopicSession("https://github.com/org/repo", "Fix the bug", "task")

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(expect.stringContaining("Failed"), 200)
      expect(ctx.telegram.deleteForumTopic).toHaveBeenCalledWith(200)
      expect(ctx.topicSessions.size).toBe(0)
    })

    it("sets branch for repo-based sessions", async () => {
      await lifecycle.startTopicSession("https://github.com/org/repo", "Fix the bug", "task")

      const session = [...ctx.topicSessions.values()][0]
      expect(session.branch).toMatch(/^minion\//)
    })

    it("uses plan emoji for plan mode", async () => {
      await lifecycle.startTopicSession("https://github.com/org/repo", "Plan something", "plan")

      expect(ctx.telegram.createForumTopic).toHaveBeenCalledWith(expect.stringContaining("📋"))
    })

    it("uses think emoji for think mode", async () => {
      await lifecycle.startTopicSession("https://github.com/org/repo", "Think about this", "think")

      expect(ctx.telegram.createForumTopic).toHaveBeenCalledWith(expect.stringContaining("🧠"))
    })

    it("uses ship emoji when autoAdvance is set", async () => {
      await lifecycle.startTopicSession(
        "https://github.com/org/repo",
        "Ship it",
        "task",
        undefined,
        undefined,
        { phase: "think", featureDescription: "Ship it", autoLand: false },
      )

      expect(ctx.telegram.createForumTopic).toHaveBeenCalledWith(expect.stringContaining("🚢"))
    })
  })

  describe("spawnTopicAgent", () => {
    it("refuses to spawn when at max concurrent sessions", async () => {
      for (let i = 0; i < 5; i++) {
        ctx.sessions.set(i, {} as any)
      }
      const session = makeSession()

      await lifecycle.spawnTopicAgent(session, "do work")

      expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Max concurrent"),
        100,
      )
    })

    it("refreshes git token before spawning", async () => {
      const session = makeSession()

      await lifecycle.spawnTopicAgent(session, "do work")

      expect(ctx.refreshGitToken).toHaveBeenCalled()
    })

    it("sets activeSessionId on the topic session", async () => {
      const session = makeSession()

      await lifecycle.spawnTopicAgent(session, "do work")

      expect(session.activeSessionId).toBeDefined()
      expect(ctx.broadcastSession).toHaveBeenCalledWith(session, "session_updated")
    })

    it("stores session in sessions map", async () => {
      const session = makeSession()

      await lifecycle.spawnTopicAgent(session, "do work")

      expect(ctx.sessions.has(100)).toBe(true)
    })

    it("updates topic title to running emoji", async () => {
      const session = makeSession()

      await lifecycle.spawnTopicAgent(session, "do work")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "⚡")
    })
  })

  describe("handleSessionComplete", () => {
    it("ignores completion if sessionId does not match", () => {
      const session = makeSession({ activeSessionId: "other-id" })
      const meta = makeMeta({ sessionId: "wrong-id" })

      lifecycle.handleSessionComplete(session, meta, "completed", "wrong-id")

      expect(ctx.stats.record).not.toHaveBeenCalled()
    })

    it("clears session state on completion", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      ctx.sessions.set(100, {} as any)
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.sessions.has(100)).toBe(false)
      expect(session.activeSessionId).toBeUndefined()
      expect(ctx.broadcastSession).toHaveBeenCalledWith(session, "session_updated", "completed")
      expect(ctx.updatePinnedSummary).toHaveBeenCalled()
    })

    it("records stats on completion", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.stats.record).toHaveBeenCalledWith(expect.objectContaining({
        slug: "test-slug",
        repo: "org/repo",
        mode: "task",
        state: "completed",
      }))
    })

    it("sets lastState to errored on error", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "errored", "session-123")

      expect(session.lastState).toBe("errored")
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "❌")
    })

    it("sets lastState to completed on success for task mode", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(session.lastState).toBe("completed")
      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "✅")
    })

    it("shows idle emoji for think mode", () => {
      const session = makeSession({ activeSessionId: "session-123", mode: "think" })
      const meta = makeMeta({ mode: "think" })

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "💬")
    })

    it("shows idle emoji for plan mode", () => {
      const session = makeSession({ activeSessionId: "session-123", mode: "plan" })
      const meta = makeMeta({ mode: "plan" })

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "💬")
    })

    it("shows idle emoji for review mode", () => {
      const session = makeSession({ activeSessionId: "session-123", mode: "review" })
      const meta = makeMeta({ mode: "review" })

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "💬")
    })

    it("persists topic sessions and cleans build artifacts", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.persistTopicSessions).toHaveBeenCalled()
      expect(ctx.cleanBuildArtifacts).toHaveBeenCalledWith("/tmp/workspace")
    })

    it("notifies parent of child completion", () => {
      const session = makeSession({ activeSessionId: "session-123" })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

      expect(ctx.notifyParentOfChildComplete).toHaveBeenCalledWith(session, "completed")
    })

    it("processes pending feedback after completion", () => {
      const session = makeSession({
        activeSessionId: "session-123",
        pendingFeedback: ["feedback 1", "feedback 2"],
      })
      const meta = makeMeta()

      lifecycle.handleSessionComplete(session, meta, "errored", "session-123")

      expect(ctx.handleTopicFeedback).toHaveBeenCalledWith(session, "feedback 1\n\nfeedback 2")
      expect(session.pendingFeedback).toEqual([])
    })

    describe("ship auto-advance", () => {
      it("advances ship pipeline on successful completion", () => {
        const session = makeSession({
          activeSessionId: "session-123",
          mode: "ship-plan",
          autoAdvance: { phase: "plan", featureDescription: "Build feature", autoLand: false },
        })
        const meta = makeMeta({ mode: "ship-plan" })

        lifecycle.handleSessionComplete(session, meta, "completed", "session-123")

        expect(ctx.observer.flushAndComplete).toHaveBeenCalled()
      })

      it("preserves phase on ship error and shows recovery options", () => {
        const session = makeSession({
          activeSessionId: "session-123",
          mode: "ship-plan",
          autoAdvance: { phase: "plan", featureDescription: "Build feature", autoLand: false },
        })
        const meta = makeMeta({ mode: "ship-plan" })

        lifecycle.handleSessionComplete(session, meta, "errored", "session-123")

        expect(session.autoAdvance!.phase).toBe("plan")
        expect(ctx.updateTopicTitle).toHaveBeenCalledWith(session, "⚠️")
        expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
          expect.stringContaining("Recovery options"),
          100,
        )
      })

      it("returns early after ship auto-advance handling", () => {
        const session = makeSession({
          activeSessionId: "session-123",
          mode: "ship-verify",
          autoAdvance: { phase: "verify", featureDescription: "Build feature", autoLand: false },
        })
        const meta = makeMeta({ mode: "ship-verify" })

        lifecycle.handleSessionComplete(session, meta, "errored", "session-123")

        expect(ctx.persistTopicSessions).toHaveBeenCalled()
        expect(ctx.cleanBuildArtifacts).toHaveBeenCalled()
        // Should NOT call notifyParentOfChildComplete since it returns early
        expect(ctx.notifyParentOfChildComplete).not.toHaveBeenCalled()
      })
    })
  })

  describe("spawnCIFixAgent", () => {
    it("skips when at max concurrent sessions", async () => {
      for (let i = 0; i < 5; i++) {
        ctx.sessions.set(i, {} as any)
      }
      const session = makeSession()
      const onComplete = vi.fn()

      await lifecycle.spawnCIFixAgent(session, "fix CI", onComplete)

      expect(onComplete).toHaveBeenCalled()
      expect(ctx.sessions.size).toBe(5)
    })

    it("sets activeSessionId and stores session", async () => {
      const session = makeSession()
      const onComplete = vi.fn()

      await lifecycle.spawnCIFixAgent(session, "fix CI", onComplete)

      expect(session.activeSessionId).toBeDefined()
      expect(ctx.sessions.has(100)).toBe(true)
    })

    it("starts observer and session handle", async () => {
      const session = makeSession()
      const onComplete = vi.fn()

      await lifecycle.spawnCIFixAgent(session, "fix CI", onComplete)

      expect(ctx.observer.onSessionStart).toHaveBeenCalled()
    })
  })
})

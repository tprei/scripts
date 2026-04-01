import { describe, it, expect, vi, beforeEach } from "vitest"
import { CallbackQueryHandler } from "../src/commands/callback-handler.js"
import type { DispatcherContext } from "../src/orchestration/dispatcher-context.js"
import type { TelegramCallbackQuery } from "../src/types.js"
import type { PendingTask } from "../src/session/session-manager.js"

function makeContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    config: {
      telegram: { botToken: "test", chatId: "123", allowedUserIds: [1] },
      repos: { myrepo: "https://github.com/org/myrepo" },
    } as any,
    telegram: {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue(42),
    } as any,
    observer: {} as any,
    stats: {} as any,
    profileStore: {
      getDefaultId: vi.fn().mockReturnValue(undefined),
      get: vi.fn().mockReturnValue(undefined),
      list: vi.fn().mockReturnValue([]),
    } as any,
    broadcaster: undefined,
    sessions: new Map(),
    topicSessions: new Map(),
    dags: new Map(),
    pendingTasks: new Map(),
    pendingProfiles: new Map(),
    refreshGitToken: vi.fn().mockResolvedValue(undefined),
    startTopicSession: vi.fn().mockResolvedValue(undefined),
    spawnTopicAgent: vi.fn().mockResolvedValue(undefined),
    spawnCIFixAgent: vi.fn().mockResolvedValue(undefined),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp"),
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
    postSessionDigest: vi.fn(),
    runDeferredBabysit: vi.fn().mockResolvedValue(undefined),
    babysitPR: vi.fn().mockResolvedValue(undefined),
    babysitDagChildCI: vi.fn().mockResolvedValue(true),
    updateDagPRDescriptions: vi.fn().mockResolvedValue(undefined),
    scheduleDagNodes: vi.fn().mockResolvedValue(undefined),
    spawnSplitChild: vi.fn().mockResolvedValue(null),
    spawnDagChild: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function makeQuery(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return {
    id: "q1",
    from: { id: 1, is_bot: false, first_name: "Test" },
    data: "repo:myrepo",
    message: { message_id: 10, date: 0, chat: { id: 123, type: "supergroup" } },
    ...overrides,
  }
}

describe("CallbackQueryHandler", () => {
  let ctx: DispatcherContext
  let handler: CallbackQueryHandler

  beforeEach(() => {
    ctx = makeContext()
    handler = new CallbackQueryHandler(ctx)
  })

  it("rejects unauthorized users", async () => {
    const query = makeQuery({ from: { id: 999, is_bot: false, first_name: "Bad" } })
    await handler.handleCallbackQuery(query)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1", "Not authorized")
    expect(ctx.startTopicSession).not.toHaveBeenCalled()
  })

  it("handles empty callback data", async () => {
    const query = makeQuery({ data: undefined })
    await handler.handleCallbackQuery(query)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1")
  })

  it("ignores unrecognized callback data prefixes", async () => {
    const query = makeQuery({ data: "unknown:data" })
    await handler.handleCallbackQuery(query)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1")
  })

  it("rejects unknown repo slug", async () => {
    const query = makeQuery({ data: "repo:nonexistent" })
    await handler.handleCallbackQuery(query)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1", "Unknown repo")
  })

  it("starts a session when repo is selected and no pending task", async () => {
    const query = makeQuery()
    await handler.handleCallbackQuery(query)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1")
    expect(ctx.startTopicSession).not.toHaveBeenCalled()
  })

  it("starts a session for a pending task with no profiles", async () => {
    const pending: PendingTask = { task: "do stuff", mode: "task" }
    ctx.pendingTasks.set(10, pending)

    await handler.handleCallbackQuery(makeQuery())

    expect(ctx.pendingTasks.has(10)).toBe(false)
    expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1", "Selected: myrepo")
    expect(ctx.telegram.deleteMessage).toHaveBeenCalledWith(10)
    expect(ctx.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/myrepo", "do stuff", "task", undefined, undefined, undefined,
    )
  })

  it("starts a session with default profile", async () => {
    ;(ctx.profileStore.getDefaultId as any).mockReturnValue("prof1")
    const pending: PendingTask = { task: "do stuff", mode: "task" }
    ctx.pendingTasks.set(10, pending)

    await handler.handleCallbackQuery(makeQuery())

    expect(ctx.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/myrepo", "do stuff", "task", undefined, "prof1", undefined,
    )
  })

  it("shows profile keyboard when multiple profiles exist", async () => {
    ;(ctx.profileStore.list as any).mockReturnValue([
      { id: "p1", name: "Profile 1" },
      { id: "p2", name: "Profile 2" },
    ])
    const pending: PendingTask = { task: "do stuff", mode: "plan", threadId: 5 }
    ctx.pendingTasks.set(10, pending)

    await handler.handleCallbackQuery(makeQuery())

    expect(ctx.telegram.sendMessageWithKeyboard).toHaveBeenCalled()
    expect(ctx.pendingProfiles.has(42)).toBe(true)
    expect(ctx.startTopicSession).not.toHaveBeenCalled()
  })

  it("handles plan-repo: prefix", async () => {
    const pending: PendingTask = { task: "plan stuff", mode: "plan" }
    ctx.pendingTasks.set(10, pending)
    const query = makeQuery({ data: "plan-repo:myrepo" })

    await handler.handleCallbackQuery(query)

    expect(ctx.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/myrepo", "plan stuff", "plan", undefined, undefined, undefined,
    )
  })

  it("handles think-repo: prefix", async () => {
    const pending: PendingTask = { task: "think stuff", mode: "think" }
    ctx.pendingTasks.set(10, pending)
    const query = makeQuery({ data: "think-repo:myrepo" })

    await handler.handleCallbackQuery(query)

    expect(ctx.startTopicSession).toHaveBeenCalled()
  })

  it("handles review-repo: prefix and builds review task", async () => {
    const pending: PendingTask = { task: "", mode: "review" }
    ctx.pendingTasks.set(10, pending)
    const query = makeQuery({ data: "review-repo:myrepo" })

    await handler.handleCallbackQuery(query)

    expect(pending.task).toContain("myrepo")
    expect(ctx.startTopicSession).toHaveBeenCalled()
  })

  it("handles ship-repo: prefix", async () => {
    const pending: PendingTask = { task: "ship it", mode: "ship-think" }
    ctx.pendingTasks.set(10, pending)
    const query = makeQuery({ data: "ship-repo:myrepo" })

    await handler.handleCallbackQuery(query)

    expect(ctx.startTopicSession).toHaveBeenCalled()
  })

  describe("profile callback", () => {
    it("rejects unknown profile", async () => {
      const query = makeQuery({ data: "profile:unknown" })
      await handler.handleCallbackQuery(query)
      expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1", "Unknown profile")
    })

    it("starts session with selected profile", async () => {
      ;(ctx.profileStore.get as any).mockReturnValue({ id: "p1", name: "Profile 1" })
      const pending: PendingTask = { task: "do stuff", mode: "task", repoUrl: "https://github.com/org/myrepo" }
      ctx.pendingProfiles.set(10, pending)

      const query = makeQuery({ data: "profile:p1" })
      await handler.handleCallbackQuery(query)

      expect(ctx.pendingProfiles.has(10)).toBe(false)
      expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1", "Selected: Profile 1")
      expect(ctx.telegram.deleteMessage).toHaveBeenCalledWith(10)
      expect(ctx.startTopicSession).toHaveBeenCalledWith(
        "https://github.com/org/myrepo", "do stuff", "task", undefined, "p1", undefined,
      )
    })

    it("answers callback when no pending profile exists", async () => {
      ;(ctx.profileStore.get as any).mockReturnValue({ id: "p1", name: "Profile 1" })
      const query = makeQuery({ data: "profile:p1" })
      await handler.handleCallbackQuery(query)
      expect(ctx.telegram.answerCallbackQuery).toHaveBeenCalledWith("q1")
      expect(ctx.startTopicSession).not.toHaveBeenCalled()
    })
  })
})

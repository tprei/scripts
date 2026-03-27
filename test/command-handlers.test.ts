import { describe, it, expect, vi } from "vitest"
import {
  handleStatusCommand,
  handleStatsCommand,
  handleHelpCommand,
  handleConfigCommand,
  type CommandHandlerDeps,
} from "../src/command-handlers.js"

function createMockDeps(overrides: Partial<CommandHandlerDeps> = {}): CommandHandlerDeps {
  const mockTelegram = {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: 123 }),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(123),
    editMessage: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    pinChatMessage: vi.fn().mockResolvedValue(true),
    getUpdates: vi.fn().mockResolvedValue([]),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 456 }),
    editForumTopic: vi.fn().mockResolvedValue(undefined),
    deleteForumTopic: vi.fn().mockResolvedValue(undefined),
  }

  const mockProfileStore = {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    getDefaultId: vi.fn().mockReturnValue(undefined),
    add: vi.fn().mockReturnValue(true),
    remove: vi.fn().mockReturnValue(true),
    update: vi.fn().mockReturnValue(true),
    setDefaultId: vi.fn().mockReturnValue(true),
    clearDefault: vi.fn().mockReturnValue(undefined),
  }

  const mockStats = {
    aggregate: vi.fn().mockResolvedValue({
      sessions: 10,
      successRate: 0.9,
      avgDurationMs: 60000,
      totalTokens: 100000,
    }),
    breakdownByMode: vi.fn().mockResolvedValue({}),
    recentSessions: vi.fn().mockResolvedValue([]),
  }

  return {
    telegram: mockTelegram as unknown as CommandHandlerDeps["telegram"],
    config: {
      repos: { "my-repo": "https://github.com/org/my-repo" },
      workspace: {
        maxConcurrentSessions: 5,
      },
      telegram: {
        allowedUserIds: [12345],
      },
    } as unknown as CommandHandlerDeps["config"],
    profileStore: mockProfileStore,
    stats: mockStats,
    getActiveSessionsCount: vi.fn().mockReturnValue(0),
    getTopicSessions: vi.fn().mockReturnValue(new Map()),
    getSessions: vi.fn().mockReturnValue(new Map()),
    onStartTopicSession: vi.fn().mockResolvedValue(undefined),
    onStartTopicSessionWithProfile: vi.fn().mockResolvedValue(undefined),
    onStartReviewSession: vi.fn().mockResolvedValue(undefined),
    pendingTasks: new Map(),
    pendingProfiles: new Map(),
    ...overrides,
  }
}

describe("handleStatusCommand", () => {
  it("sends status message", async () => {
    const deps = createMockDeps()
    await handleStatusCommand(deps)
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })
})

describe("handleStatsCommand", () => {
  it("sends stats message", async () => {
    const deps = createMockDeps()
    await handleStatsCommand(deps)
    expect(deps.stats.aggregate).toHaveBeenCalledWith(7)
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })
})

describe("handleHelpCommand", () => {
  it("sends help message", async () => {
    const deps = createMockDeps()
    await handleHelpCommand(deps)
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })
})

describe("handleConfigCommand", () => {
  it("shows profile list when no args", async () => {
    const deps = createMockDeps({
      profileStore: {
        ...createMockDeps().profileStore,
        list: () => [{ id: "default", name: "Default Profile" }],
        getDefaultId: () => "default",
      },
    })
    await handleConfigCommand("", deps)
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
    const call = (deps.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toContain("Provider profiles")
  })

  it("adds a profile", async () => {
    const deps = createMockDeps()
    await handleConfigCommand("add test Test Profile", deps)
    expect(deps.profileStore.add).toHaveBeenCalledWith({ id: "test", name: "Test Profile" })
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })

  it("sets a profile field", async () => {
    const deps = createMockDeps()
    await handleConfigCommand("set test name New Name", deps)
    expect(deps.profileStore.update).toHaveBeenCalledWith("test", { name: "New Name" })
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })

  it("removes a profile", async () => {
    const deps = createMockDeps()
    await handleConfigCommand("remove test", deps)
    expect(deps.profileStore.remove).toHaveBeenCalledWith("test")
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })

  it("sets default profile", async () => {
    const deps = createMockDeps({
      profileStore: {
        ...createMockDeps().profileStore,
        get: () => ({ id: "test", name: "Test" }),
      },
    })
    await handleConfigCommand("default test", deps)
    expect(deps.profileStore.setDefaultId).toHaveBeenCalledWith("test")
    expect(deps.telegram.sendMessage).toHaveBeenCalled()
  })
})

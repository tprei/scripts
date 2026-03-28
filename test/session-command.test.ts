import { describe, it, expect, vi, beforeEach } from "vitest"
import { Dispatcher } from "../src/dispatcher.js"
import type { TelegramClient } from "../src/telegram.js"
import { Observer } from "../src/observer.js"
import type { MinionConfig } from "../src/config-types.js"
import { ProfileStore } from "../src/profile-store.js"

function makeMockTelegram(): TelegramClient {
  return {
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "supergroup" } }),
    editMessage: vi.fn().mockResolvedValue(true),
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: "test" }),
    getUpdates: vi.fn().mockResolvedValue([]),
    downloadFile: vi.fn().mockResolvedValue(false),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    sendMessageWithKeyboard: vi.fn().mockResolvedValue(99),
    pinMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as unknown as TelegramClient
}

function makeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    telegram: { token: "test", chatId: "1", allowedUserIds: [1] },
    workspace: {
      root: "/tmp/test-workspace",
      maxConcurrentSessions: 2,
      sessionTimeoutMs: 60_000,
      staleTtlMs: 86_400_000,
    },
    repos: {
      scripts: "https://github.com/tprei/scripts",
      app: "https://github.com/org/app",
    },
    session: {
      goose: { provider: "test", model: "test" },
      claude: { planModel: "test", thinkModel: "test" },
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
    },
    ci: {
      enabled: false,
      babysitMaxRetries: 0,
      qualityGatesEnabled: false,
    },
    ...overrides,
  } as MinionConfig
}

type DispatcherPrivate = {
  handleSessionCommand(mode: "task" | "plan" | "think", args: string, replyThreadId?: number, photos?: unknown[]): Promise<void>
  handleReviewCommand(args: string, replyThreadId?: number): Promise<void>
  resolveProfileAndStart(repoUrl: string | undefined, task: string, mode: string, replyThreadId?: number, photos?: unknown[]): Promise<void>
  pendingTasks: Map<number, unknown>
  pendingProfiles: Map<number, unknown>
  sessions: Map<number, unknown>
  startTopicSession: (...args: unknown[]) => Promise<void>
  profileStore: ProfileStore
}

function makeDispatcher(configOverrides: Partial<MinionConfig> = {}) {
  const telegram = makeMockTelegram()
  const config = makeConfig(configOverrides)
  const observer = new Observer(telegram, 1)
  const dispatcher = new Dispatcher(telegram, observer, config)
  const priv = dispatcher as unknown as DispatcherPrivate
  priv.startTopicSession = vi.fn().mockResolvedValue(undefined)
  return { dispatcher, telegram, config, priv }
}

describe("handleSessionCommand", () => {
  describe("usage messages", () => {
    it("shows task usage when no task provided", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("task", "", 42)
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/task"),
        42,
      )
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<code>scripts</code>"),
        42,
      )
    })

    it("shows plan usage when no task provided", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("plan", "", 42)
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/plan"),
        42,
      )
    })

    it("shows think usage when no task provided", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("think", "", 42)
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("/think"),
        42,
      )
    })

    it("does not send usage when replyThreadId is undefined", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("task", "", undefined)
      expect(telegram.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe("max concurrent sessions (task only)", () => {
    it("rejects task when at max sessions", async () => {
      const { telegram, priv } = makeDispatcher()
      priv.sessions.set(1, {} as unknown)
      priv.sessions.set(2, {} as unknown)
      await priv.handleSessionCommand("task", "fix bug", 42)
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Max concurrent sessions"),
        42,
      )
      expect(priv.startTopicSession).not.toHaveBeenCalled()
    })

    it("does not reject plan when at max sessions", async () => {
      const { priv } = makeDispatcher()
      priv.sessions.set(1, {} as unknown)
      priv.sessions.set(2, {} as unknown)
      await priv.handleSessionCommand("plan", "scripts plan something", 42)
      expect(priv.startTopicSession).toHaveBeenCalled()
    })

    it("does not reject think when at max sessions", async () => {
      const { priv } = makeDispatcher()
      priv.sessions.set(1, {} as unknown)
      priv.sessions.set(2, {} as unknown)
      await priv.handleSessionCommand("think", "scripts research something", 42)
      expect(priv.startTopicSession).toHaveBeenCalled()
    })
  })

  describe("repo keyboard", () => {
    it("shows repo keyboard for task when no repo provided", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("task", "fix the bug", 42)
      expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
        expect.stringContaining("Pick a repo for:"),
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "repo:scripts" }),
          ]),
        ]),
        42,
      )
    })

    it("shows repo keyboard with plan-repo: prefix for plan", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("plan", "plan the feature", 42)
      expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
        expect.stringContaining("Pick a repo for plan:"),
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "plan-repo:scripts" }),
          ]),
        ]),
        42,
      )
    })

    it("shows repo keyboard with think-repo: prefix for think", async () => {
      const { telegram, priv } = makeDispatcher()
      await priv.handleSessionCommand("think", "research the topic", 42)
      expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
        expect.stringContaining("Pick a repo for research:"),
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "think-repo:scripts" }),
          ]),
        ]),
        42,
      )
    })

    it("stores pending task when keyboard shown", async () => {
      const { priv } = makeDispatcher()
      await priv.handleSessionCommand("task", "fix bug", 42)
      expect(priv.pendingTasks.has(99)).toBe(true)
      const pending = priv.pendingTasks.get(99) as { task: string; threadId: number; mode: string }
      expect(pending.task).toBe("fix bug")
      expect(pending.mode).toBe("task")
      expect(pending.threadId).toBe(42)
    })
  })

  describe("direct session start", () => {
    it("starts session directly with repo alias", async () => {
      const { priv } = makeDispatcher()
      await priv.handleSessionCommand("task", "scripts fix the bug", 42)
      expect(priv.startTopicSession).toHaveBeenCalledWith(
        "https://github.com/tprei/scripts",
        "fix the bug",
        "task",
        undefined,
      )
    })

    it("starts session directly with URL", async () => {
      const { priv } = makeDispatcher()
      await priv.handleSessionCommand("plan", "https://github.com/org/repo plan feature", 42)
      expect(priv.startTopicSession).toHaveBeenCalledWith(
        "https://github.com/org/repo",
        "plan feature",
        "plan",
        undefined,
      )
    })

    it("skips repo keyboard when no repos configured", async () => {
      const { priv } = makeDispatcher({ repos: {} } as Partial<MinionConfig>)
      await priv.handleSessionCommand("task", "fix bug", 42)
      expect(priv.startTopicSession).toHaveBeenCalledWith(
        undefined,
        "fix bug",
        "task",
        undefined,
      )
    })
  })

  describe("profile resolution", () => {
    it("uses default profile when available", async () => {
      const { priv } = makeDispatcher()
      vi.spyOn(priv.profileStore, "getDefaultId").mockReturnValue("default-1")
      await priv.handleSessionCommand("task", "scripts fix bug", 42)
      expect(priv.startTopicSession).toHaveBeenCalledWith(
        "https://github.com/tprei/scripts",
        "fix bug",
        "task",
        undefined,
        "default-1",
      )
    })

    it("shows profile keyboard when multiple profiles and no default", async () => {
      const { telegram, priv } = makeDispatcher()
      vi.spyOn(priv.profileStore, "getDefaultId").mockReturnValue(undefined)
      vi.spyOn(priv.profileStore, "list").mockReturnValue([
        { id: "p1", name: "Profile 1" },
        { id: "p2", name: "Profile 2" },
      ] as Array<{ id: string; name: string }>)
      await priv.handleSessionCommand("plan", "scripts plan feature", 42)
      expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
        expect.stringContaining("Pick a profile for plan:"),
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "profile:p1" }),
          ]),
        ]),
        42,
      )
      expect(priv.pendingProfiles.has(99)).toBe(true)
    })
  })
})

describe("handleReviewCommand", () => {
  it("shows review usage when no repos configured and no args", async () => {
    const { telegram, priv } = makeDispatcher({ repos: {} } as Partial<MinionConfig>)
    await priv.handleReviewCommand("", 42)
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("/review"),
      42,
    )
  })

  it("shows repo keyboard when no args and multiple repos", async () => {
    const { telegram, priv } = makeDispatcher()
    await priv.handleReviewCommand("", 42)
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
      expect.stringContaining("review all unreviewed PRs"),
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ callback_data: "review-repo:scripts" }),
        ]),
      ]),
      42,
    )
  })

  it("starts review session for single repo with no args", async () => {
    const { priv } = makeDispatcher({ repos: { only: "https://github.com/org/only" } } as Partial<MinionConfig>)
    await priv.handleReviewCommand("", 42)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/only",
      expect.stringContaining("Review all open pull requests"),
      "review",
      undefined,
    )
  })

  it("starts review with repo alias and PR number", async () => {
    const { priv } = makeDispatcher()
    await priv.handleReviewCommand("scripts 42", 10)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/tprei/scripts",
      "Review PR #42",
      "review",
      undefined,
    )
  })

  it("starts review-all when repo alias given without PR number", async () => {
    const { priv } = makeDispatcher()
    await priv.handleReviewCommand("scripts", 10)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/tprei/scripts",
      expect.stringContaining("Review all open pull requests"),
      "review",
      undefined,
    )
  })

  it("shows repo keyboard when PR number but no repo", async () => {
    const { telegram, priv } = makeDispatcher()
    await priv.handleReviewCommand("42", 10)
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
      expect.stringContaining("Pick a repo for review"),
      expect.any(Array),
      10,
    )
  })
})

describe("resolveProfileAndStart", () => {
  it("uses default profile", async () => {
    const { priv } = makeDispatcher()
    vi.spyOn(priv.profileStore, "getDefaultId").mockReturnValue("def")
    await priv.resolveProfileAndStart("https://github.com/org/repo", "task text", "task", 42)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "task text",
      "task",
      undefined,
      "def",
    )
  })

  it("shows profile keyboard for review mode", async () => {
    const { telegram, priv } = makeDispatcher()
    vi.spyOn(priv.profileStore, "getDefaultId").mockReturnValue(undefined)
    vi.spyOn(priv.profileStore, "list").mockReturnValue([
      { id: "p1", name: "A" },
      { id: "p2", name: "B" },
    ] as Array<{ id: string; name: string }>)
    await priv.resolveProfileAndStart("https://github.com/org/repo", "Review PR #1", "review", 42)
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledWith(
      expect.stringContaining("Pick a profile for review:"),
      expect.any(Array),
      42,
    )
  })

  it("starts session without profile when single profile", async () => {
    const { priv } = makeDispatcher()
    vi.spyOn(priv.profileStore, "getDefaultId").mockReturnValue(undefined)
    vi.spyOn(priv.profileStore, "list").mockReturnValue([
      { id: "p1", name: "A" },
    ] as Array<{ id: string; name: string }>)
    await priv.resolveProfileAndStart("https://github.com/org/repo", "do stuff", "think", 42)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "do stuff",
      "think",
      undefined,
    )
  })

  it("passes photos through to startTopicSession", async () => {
    const { priv } = makeDispatcher()
    const photos = [{ file_id: "abc", width: 100, height: 100 }]
    await priv.resolveProfileAndStart("https://github.com/org/repo", "fix it", "task", 42, photos)
    expect(priv.startTopicSession).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "fix it",
      "task",
      photos,
    )
  })
})

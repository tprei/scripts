/**
 * Command handlers extracted from Dispatcher.
 * Each handler receives dependencies explicitly for testability.
 */

import type { TelegramClient } from "./telegram.js"
import type { MinionConfig } from "./config-types.js"
import type { TelegramCallbackQuery, TelegramPhotoSize, TopicSession } from "./types.js"
import { formatStatus, formatStats, formatUsage, formatHelp, formatProfileList, formatConfigHelp } from "./format.js"
import {
  parseTaskArgs,
  parseReviewArgs,
  buildReviewAllTask,
  buildRepoKeyboard,
  buildProfileKeyboard,
  escapeHtml,
} from "./command-parser.js"

// Re-export escapeHtml for use in helpers
const _escapeHtml = escapeHtml

/**
 * Minimal interface for session handle needed by formatStatus.
 */
interface SessionHandleLike {
  isActive(): boolean
  getState(): string
}

/**
 * Session info as stored in Dispatcher.
 */
export interface ActiveSessionInfo {
  handle: SessionHandleLike
  meta: {
    sessionId: string
    threadId: number
    topicName: string
    repo: string
    cwd: string
    startedAt: number
    mode: string
    totalTokens?: number
  }
  task: string
}

/**
 * Pending task info for repo/profile selection.
 */
export interface PendingTask {
  task: string
  threadId?: number
  mode: "task" | "plan" | "think" | "review"
  repoUrl?: string
  repoSlug?: string
}

/**
 * Pending profile selection info.
 */
export interface PendingProfile {
  task: string
  threadId?: number
  mode: "task" | "plan" | "think" | "review"
  repoUrl?: string
}

/**
 * Dependencies needed by command handlers.
 * This interface allows handlers to be decoupled from the full Dispatcher.
 */
export interface CommandHandlerDeps {
  telegram: TelegramClient
  config: MinionConfig
  profileStore: {
    list: () => { id: string; name: string }[]
    get: (id: string) => { id: string; name: string } | undefined
    getDefaultId: () => string | undefined
    add: (profile: { id: string; name: string }) => boolean
    remove: (id: string) => boolean
    update: (id: string, fields: Record<string, string>) => boolean
    setDefaultId: (id: string) => boolean
    clearDefault: () => void
  }
  stats: {
    aggregate: (days: number) => Promise<unknown>
    breakdownByMode: (days: number) => Promise<unknown>
    recentSessions: (limit: number) => Promise<unknown>
  }

  // State accessors
  getActiveSessionsCount: () => number
  getTopicSessions: () => Map<number, TopicSession>
  getSessions: () => Map<number, ActiveSessionInfo>

  // Callbacks for triggering actions
  onStartTopicSession: (
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review",
    photos?: TelegramPhotoSize[],
    profileId?: string,
  ) => Promise<void>
  onStartTopicSessionWithProfile: (
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review",
    profileId?: string,
  ) => Promise<void>
  onStartReviewSession: (repoUrl: string, task: string, replyThreadId?: number) => Promise<void>

  // Pending state management
  pendingTasks: Map<number, PendingTask>
  pendingProfiles: Map<number, PendingProfile>
}

/**
 * Handles /status command - shows active sessions.
 */
export async function handleStatusCommand(deps: CommandHandlerDeps): Promise<void> {
  const taskSessions = [...deps.getSessions().values()]
  const topicSessionList = [...deps.getTopicSessions().values()]
  const msg = formatStatus(taskSessions, topicSessionList, deps.config.workspace.maxConcurrentSessions)
  await deps.telegram.sendMessage(msg)
}

/**
 * Handles /stats command - shows session statistics.
 */
export async function handleStatsCommand(deps: CommandHandlerDeps): Promise<void> {
  const agg = await deps.stats.aggregate(7)
  await deps.telegram.sendMessage(formatStats(agg as Parameters<typeof formatStats>[0]))
}

/**
 * Handles /usage command - shows Claude usage statistics.
 */
export async function handleUsageCommand(deps: CommandHandlerDeps): Promise<void> {
  const { fetchClaudeUsage } = await import("./claude-usage.js")
  const [acpUsage, agg, breakdown, recent] = await Promise.all([
    fetchClaudeUsage(),
    deps.stats.aggregate(7),
    deps.stats.breakdownByMode(7),
    deps.stats.recentSessions(5),
  ])
  await deps.telegram.sendMessage(formatUsage(
    acpUsage,
    agg as Parameters<typeof formatUsage>[1],
    breakdown as Parameters<typeof formatUsage>[2],
    recent as Parameters<typeof formatUsage>[3],
  ))
}

/**
 * Handles /help command - shows available commands.
 */
export async function handleHelpCommand(deps: CommandHandlerDeps): Promise<void> {
  await deps.telegram.sendMessage(formatHelp())
}

/**
 * Handles /config command - manages profiles.
 */
export async function handleConfigCommand(args: string, deps: CommandHandlerDeps): Promise<void> {
  if (!args) {
    const profiles = deps.profileStore.list()
    const defaultId = deps.profileStore.getDefaultId()
    await deps.telegram.sendMessage(formatProfileList(profiles, defaultId))
    return
  }

  const parts = args.split(/\s+/)
  const subcommand = parts[0]

  if (subcommand === "add" && parts.length >= 3) {
    const id = parts[1]
    const name = parts.slice(2).join(" ")
    const added = deps.profileStore.add({ id, name })
    if (added) {
      await deps.telegram.sendMessage(`✅ Added profile <code>${escapeHtml(id)}</code>`)
    } else {
      await deps.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> already exists`)
    }
    return
  }

  if (subcommand === "set" && parts.length >= 4) {
    const id = parts[1]
    const field = parts[2]
    const value = parts.slice(3).join(" ")
    const validFields = ["name", "baseUrl", "authToken", "opusModel", "sonnetModel", "haikuModel"]
    if (!validFields.includes(field)) {
      await deps.telegram.sendMessage(`❌ Invalid field. Valid: ${validFields.join(", ")}`)
      return
    }
    const updated = deps.profileStore.update(id, { [field]: value })
    if (updated) {
      await deps.telegram.sendMessage(`✅ Updated <code>${escapeHtml(id)}.${escapeHtml(field)}</code>`)
    } else {
      await deps.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
    }
    return
  }

  if (subcommand === "remove" && parts.length >= 2) {
    const id = parts[1]
    const removed = deps.profileStore.remove(id)
    if (removed) {
      await deps.telegram.sendMessage(`✅ Removed profile <code>${escapeHtml(id)}</code>`)
    } else {
      await deps.telegram.sendMessage(`❌ Cannot remove <code>${escapeHtml(id)}</code> (not found or is default)`)
    }
    return
  }

  if (subcommand === "default") {
    if (parts.length === 1) {
      deps.profileStore.clearDefault()
      await deps.telegram.sendMessage(`✅ Cleared default profile`)
      return
    }
    const id = parts[1]
    if (id === "clear") {
      deps.profileStore.clearDefault()
      await deps.telegram.sendMessage(`✅ Cleared default profile`)
      return
    }
    const set = deps.profileStore.setDefaultId(id)
    if (set) {
      const profile = deps.profileStore.get(id)
      await deps.telegram.sendMessage(`✅ Default profile set to <code>${escapeHtml(id)}</code> (${escapeHtml(profile?.name ?? id)})`)
    } else {
      await deps.telegram.sendMessage(`❌ Profile <code>${escapeHtml(id)}</code> not found`)
    }
    return
  }

  await deps.telegram.sendMessage(formatConfigHelp())
}

/**
 * Handles /task command - starts a new task session.
 */
export async function handleTaskCommand(
  args: string,
  replyThreadId: number | undefined,
  photos: TelegramPhotoSize[] | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  if (deps.getActiveSessionsCount() >= deps.config.workspace.maxConcurrentSessions) {
    if (replyThreadId !== undefined) {
      await deps.telegram.sendMessage(
        `⚠️ Max concurrent sessions (${deps.config.workspace.maxConcurrentSessions}) reached. Wait for one to finish.`,
        replyThreadId,
      )
    }
    return
  }

  const { repoUrl, task } = parseTaskArgs(deps.config.repos, args)

  if (!task) {
    if (replyThreadId !== undefined) {
      await deps.telegram.sendMessage(
        `Usage: <code>/task [repo] description of the task</code> (alias: <code>/w</code>)\n` +
        `Repos: ${Object.keys(deps.config.repos).map((s) => `<code>${s}</code>`).join(", ")}\n` +
        `Or use a full URL or omit repo entirely.`,
        replyThreadId,
      )
    }
    return
  }

  if (!repoUrl) {
    const repoKeys = Object.keys(deps.config.repos)
    if (repoKeys.length > 0) {
      const keyboard = buildRepoKeyboard(repoKeys)
      const msgId = await deps.telegram.sendMessageWithKeyboard(
        `Pick a repo for: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        deps.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "task" })
      }
      return
    }
  }

  const defaultProfileId = deps.profileStore.getDefaultId()
  if (defaultProfileId) {
    await deps.onStartTopicSession(repoUrl, task, "task", photos, defaultProfileId)
    return
  }

  const profiles = deps.profileStore.list()
  if (profiles.length > 1) {
    const keyboard = buildProfileKeyboard(profiles)
    const msgId = await deps.telegram.sendMessageWithKeyboard(
      `Pick a profile for: <i>${escapeHtml(task)}</i>`,
      keyboard,
      replyThreadId,
    )
    if (msgId) {
      deps.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "task" })
    }
    return
  }

  await deps.onStartTopicSession(repoUrl, task, "task", photos)
}

/**
 * Handles /plan command - starts a new planning session.
 */
export async function handlePlanCommand(
  args: string,
  replyThreadId: number | undefined,
  photos: TelegramPhotoSize[] | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  const { repoUrl, task } = parseTaskArgs(deps.config.repos, args)

  if (!task) {
    if (replyThreadId !== undefined) {
      await deps.telegram.sendMessage(
        `Usage: <code>/plan [repo] description of what to plan</code>`,
        replyThreadId,
      )
    }
    return
  }

  if (!repoUrl) {
    const repoKeys = Object.keys(deps.config.repos)
    if (repoKeys.length > 0) {
      const keyboard = buildRepoKeyboard(repoKeys, "plan")
      const msgId = await deps.telegram.sendMessageWithKeyboard(
        `Pick a repo for plan: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        deps.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "plan" })
      }
      return
    }
  }

  const defaultProfileId = deps.profileStore.getDefaultId()
  if (defaultProfileId) {
    await deps.onStartTopicSession(repoUrl, task, "plan", photos, defaultProfileId)
    return
  }

  const profiles = deps.profileStore.list()
  if (profiles.length > 1) {
    const keyboard = buildProfileKeyboard(profiles)
    const msgId = await deps.telegram.sendMessageWithKeyboard(
      `Pick a profile for plan: <i>${escapeHtml(task)}</i>`,
      keyboard,
      replyThreadId,
    )
    if (msgId) {
      deps.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "plan" })
    }
    return
  }

  await deps.onStartTopicSession(repoUrl, task, "plan", photos)
}

/**
 * Handles /think command - starts a new research session.
 */
export async function handleThinkCommand(
  args: string,
  replyThreadId: number | undefined,
  photos: TelegramPhotoSize[] | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  const { repoUrl, task } = parseTaskArgs(deps.config.repos, args)

  if (!task) {
    if (replyThreadId !== undefined) {
      await deps.telegram.sendMessage(
        `Usage: <code>/think [repo] question or topic to research</code>`,
        replyThreadId,
      )
    }
    return
  }

  if (!repoUrl) {
    const repoKeys = Object.keys(deps.config.repos)
    if (repoKeys.length > 0) {
      const keyboard = buildRepoKeyboard(repoKeys, "think")
      const msgId = await deps.telegram.sendMessageWithKeyboard(
        `Pick a repo for research: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        deps.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "think" })
      }
      return
    }
  }

  const defaultProfileId = deps.profileStore.getDefaultId()
  if (defaultProfileId) {
    await deps.onStartTopicSession(repoUrl, task, "think", photos, defaultProfileId)
    return
  }

  const profiles = deps.profileStore.list()
  if (profiles.length > 1) {
    const keyboard = buildProfileKeyboard(profiles)
    const msgId = await deps.telegram.sendMessageWithKeyboard(
      `Pick a profile for research: <i>${escapeHtml(task)}</i>`,
      keyboard,
      replyThreadId,
    )
    if (msgId) {
      deps.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode: "think" })
    }
    return
  }

  await deps.onStartTopicSession(repoUrl, task, "think", photos)
}

/**
 * Handles /review command - starts a new review session.
 */
export async function handleReviewCommand(
  args: string,
  replyThreadId: number | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  const parsed = parseReviewArgs(deps.config.repos, args)

  if (!parsed.repoUrl && !parsed.task) {
    const repoKeys = Object.keys(deps.config.repos)
    if (repoKeys.length === 0) {
      if (replyThreadId !== undefined) {
        await deps.telegram.sendMessage(
          `Usage: <code>/review [repo] [PR#]</code>\nNo repos configured.`,
          replyThreadId,
        )
      }
      return
    }
    if (repoKeys.length === 1) {
      const repoUrl = deps.config.repos[repoKeys[0]]
      const task = buildReviewAllTask(repoUrl)
      await deps.onStartReviewSession(repoUrl, task, replyThreadId)
      return
    }
    const keyboard = buildRepoKeyboard(repoKeys, "review")
    const msgId = await deps.telegram.sendMessageWithKeyboard(
      `Pick a repo to review all unreviewed PRs:`,
      keyboard,
      replyThreadId,
    )
    if (msgId) {
      deps.pendingTasks.set(msgId, { task: "", threadId: replyThreadId, mode: "review" })
    }
    return
  }

  if (parsed.repoUrl && !parsed.task) {
    const task = buildReviewAllTask(parsed.repoUrl)
    await deps.onStartReviewSession(parsed.repoUrl, task, replyThreadId)
    return
  }

  if (!parsed.repoUrl && parsed.task) {
    const repoKeys = Object.keys(deps.config.repos)
    if (repoKeys.length > 0) {
      const keyboard = buildRepoKeyboard(repoKeys, "review")
      const msgId = await deps.telegram.sendMessageWithKeyboard(
        `Pick a repo for review: <i>${escapeHtml(parsed.task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        deps.pendingTasks.set(msgId, { task: parsed.task, threadId: replyThreadId, mode: "review" })
      }
      return
    }
  }

  if (parsed.repoUrl && parsed.task) {
    await deps.onStartReviewSession(parsed.repoUrl, parsed.task, replyThreadId)
    return
  }
}

/**
 * Handles callback queries from inline keyboards.
 */
export async function handleCallbackQuery(
  query: TelegramCallbackQuery,
  deps: CommandHandlerDeps,
): Promise<void> {
  if (!deps.config.telegram.allowedUserIds.includes(query.from.id)) {
    await deps.telegram.answerCallbackQuery(query.id, "Not authorized")
    return
  }

  const data = query.data
  if (!data) {
    await deps.telegram.answerCallbackQuery(query.id)
    return
  }

  if (data.startsWith("profile:")) {
    await handleProfileCallback(query, data.slice("profile:".length), deps)
    return
  }

  if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:") && !data.startsWith("review-repo:")) {
    await deps.telegram.answerCallbackQuery(query.id)
    return
  }

  const isThink = data.startsWith("think-repo:")
  const isPlan = data.startsWith("plan-repo:")
  const isReview = data.startsWith("review-repo:")
  const repoSlug = isThink
    ? data.slice("think-repo:".length)
    : isPlan
    ? data.slice("plan-repo:".length)
    : isReview
    ? data.slice("review-repo:".length)
    : data.slice("repo:".length)
  const repoUrl = deps.config.repos[repoSlug]
  if (!repoUrl) {
    await deps.telegram.answerCallbackQuery(query.id, "Unknown repo")
    return
  }

  const messageId = query.message?.message_id

  if (messageId) {
    const pending = deps.pendingTasks.get(messageId)
    if (pending) {
      deps.pendingTasks.delete(messageId)
      await deps.telegram.answerCallbackQuery(query.id, `Selected: ${repoSlug}`)
      await deps.telegram.deleteMessage(messageId)

      pending.repoSlug = repoSlug
      pending.repoUrl = repoUrl
      if (pending.mode === "review" && !pending.task) {
        pending.task = buildReviewAllTask(repoUrl)
      }

      const defaultProfileId = deps.profileStore.getDefaultId()
      if (defaultProfileId) {
        await deps.onStartTopicSessionWithProfile(repoUrl, pending.task, pending.mode, defaultProfileId)
      } else {
        const profiles = deps.profileStore.list()
        if (profiles.length > 1) {
          const keyboard = buildProfileKeyboard(profiles)
          const msgId = await deps.telegram.sendMessageWithKeyboard(
            `Pick a profile for: <i>${escapeHtml(pending.task)}</i>`,
            keyboard,
            pending.threadId,
          )
          if (msgId) {
            deps.pendingProfiles.set(msgId, pending)
          }
        } else {
          await deps.onStartTopicSessionWithProfile(repoUrl, pending.task, pending.mode, undefined)
        }
      }
      return
    }
  }

  await deps.telegram.answerCallbackQuery(query.id)
}

/**
 * Handles profile selection callbacks.
 */
export async function handleProfileCallback(
  query: TelegramCallbackQuery,
  profileId: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const profile = deps.profileStore.get(profileId)
  if (!profile) {
    await deps.telegram.answerCallbackQuery(query.id, "Unknown profile")
    return
  }

  const messageId = query.message?.message_id
  if (messageId) {
    const pending = deps.pendingProfiles.get(messageId)
    if (pending) {
      deps.pendingProfiles.delete(messageId)
      await deps.telegram.answerCallbackQuery(query.id, `Selected: ${profile.name}`)
      await deps.telegram.deleteMessage(messageId)
      await deps.onStartTopicSessionWithProfile(pending.repoUrl, pending.task, pending.mode, profileId)
      return
    }
  }

  await deps.telegram.answerCallbackQuery(query.id)
}

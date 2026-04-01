import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TelegramClient } from "../telegram/telegram.js"
import { captureException } from "../sentry.js"
import { SessionHandle } from "../session/session.js"
import { Observer } from "../telegram/observer.js"
import type { TelegramUpdate, TelegramCallbackQuery, TelegramPhotoSize, SessionMeta, TopicSession, SessionMode, SessionState, TopicMessage, AutoAdvance } from "../types.js"
import { generateSlug, taskToLabel } from "../slugs.js"
import type { MinionConfig, McpConfig } from "../config/config-types.js"
import type { GitHubTokenProvider } from "../github/index.js"
import { SessionStore } from "../store.js"
import { DagStore } from "../dag-store.js"
import { ProfileStore } from "../profile-store.js"
import {
  formatPlanIteration,
  formatThinkIteration,
  formatReviewIteration,
  formatFollowUpIteration,
} from "../telegram/format.js"
import { StatsTracker } from "../stats.js"
import { extractPRUrl } from "../ci/ci-babysit.js"
import { buildConversationDigest, buildChildSessionDigest } from "../conversation-digest.js"
import { truncateConversation } from "../conversation-limits.js"
import { StateBroadcaster, topicSessionToApi, dagToApi } from "../api-server.js"
import { loggers } from "../logger.js"
import { SessionNotFoundError } from "../errors.js"
import {
  parseTaskArgs, buildReviewAllTask,
  buildRepoKeyboard, buildProfileKeyboard,
  escapeHtml, appendImageContext,
} from "../commands/command-parser.js"
import {
  type ActiveSession, type PendingTask,
  buildContextPrompt,
  prepareWorkspace, removeWorkspace, cleanBuildArtifacts,
  downloadPhotos, prepareFanInBranch, mergeUpstreamBranches,
} from "../session/session-manager.js"
import { buildSplitChildPrompt } from "./split.js"
import { advanceDag, failNode, renderDagStatus, type DagGraph } from "../dag/dag.js"
import type { DispatcherContext } from "./dispatcher-context.js"
import { CIBabysitter } from "../ci/ci-babysitter.js"
import { LandingManager } from "../dag/landing-manager.js"
import { DagOrchestrator } from "../dag/dag-orchestrator.js"
import { ShipPipeline } from "./ship-pipeline.js"
import { SessionLifecycle } from "./session-lifecycle.js"
import { SplitOrchestrator } from "./split-orchestrator.js"
import { JudgeOrchestrator } from "../judge/judge-orchestrator.js"
import { PinnedMessageManager } from "../telegram/pinned-message-manager.js"
import { routeCommand } from "../commands/command-router.js"
import { CommandHandler } from "../commands/command-handler.js"

const log = loggers.dispatcher

const POLL_TIMEOUT = 30

export class Dispatcher {
  private readonly sessions = new Map<number, ActiveSession>()
  private readonly topicSessions = new Map<number, TopicSession>()
  private readonly pendingTasks = new Map<number, PendingTask>()
  private readonly pendingProfiles = new Map<number, PendingTask>()
  private readonly store: SessionStore
  private readonly dagStore: DagStore
  private readonly profileStore: ProfileStore
  private readonly dags = new Map<string, DagGraph>()
  private readonly broadcaster?: StateBroadcaster
  private offset = 0
  private running = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private readonly stats: StatsTracker

  private readonly ciBabysitter: CIBabysitter
  private readonly landingManager: LandingManager
  private readonly dagOrchestrator: DagOrchestrator
  private readonly shipPipeline: ShipPipeline
  private readonly sessionLifecycle: SessionLifecycle
  private readonly splitOrchestrator: SplitOrchestrator
  private readonly judgeOrchestrator: JudgeOrchestrator
  private readonly commandHandler: CommandHandler
  private readonly pinnedMessages: PinnedMessageManager

  constructor(
    private readonly telegram: TelegramClient,
    private readonly observer: Observer,
    private readonly config: MinionConfig,
    broadcaster?: StateBroadcaster,
    private readonly tokenProvider?: GitHubTokenProvider,
  ) {
    this.broadcaster = broadcaster
    this.store = new SessionStore(this.config.workspace.root)
    this.dagStore = new DagStore(this.config.workspace.root)
    this.profileStore = new ProfileStore(this.config.workspace.root)
    this.stats = new StatsTracker(this.config.workspace.root)

    const ctx = this.buildContext()
    this.ciBabysitter = new CIBabysitter(ctx)
    this.landingManager = new LandingManager(ctx)
    this.dagOrchestrator = new DagOrchestrator(ctx)
    this.shipPipeline = new ShipPipeline(ctx)
    this.sessionLifecycle = new SessionLifecycle(ctx)
    this.splitOrchestrator = new SplitOrchestrator(ctx)
    this.judgeOrchestrator = new JudgeOrchestrator(ctx)
    this.commandHandler = new CommandHandler(ctx)
    this.pinnedMessages = new PinnedMessageManager({
      telegram: this.telegram,
      topicSessions: this.topicSessions,
      workspaceRoot: this.config.workspace.root,
      chatId: this.config.telegram.chatId,
    })
  }

  private buildContext(): DispatcherContext {
    return {
      config: this.config,
      telegram: this.telegram,
      observer: this.observer,
      stats: this.stats,
      profileStore: this.profileStore,
      broadcaster: this.broadcaster,
      sessions: this.sessions,
      topicSessions: this.topicSessions,
      dags: this.dags,
      pendingTasks: this.pendingTasks,
      refreshGitToken: () => this.refreshGitToken(),
      spawnTopicAgent: (ts, task, mcp, sp) => this.sessionLifecycle.spawnTopicAgent(ts, task, mcp, sp),
      spawnCIFixAgent: (ts, task, cb) => this.sessionLifecycle.spawnCIFixAgent(ts, task, cb),
      prepareWorkspace: (slug, repo, branch) => this.prepareWorkspace(slug, repo, branch),
      removeWorkspace: (ts) => this.removeWorkspace(ts),
      cleanBuildArtifacts: (cwd) => this.cleanBuildArtifacts(cwd),
      prepareFanInBranch: (slug, repo, branches) => this.prepareFanInBranch(slug, repo, branches),
      mergeUpstreamBranches: (dir, branches) => this.mergeUpstreamBranches(dir, branches),
      downloadPhotos: (photos) => this.downloadPhotos(photos),
      pushToConversation: (s, m) => this.pushToConversation(s, m),
      extractPRFromConversation: (ts) => this.extractPRFromConversation(ts),
      persistTopicSessions: (mark) => this.persistTopicSessions(mark),
      persistDags: () => this.persistDags(),
      updatePinnedSummary: () => this.pinnedMessages.updatePinnedSummary(),
      updateTopicTitle: (ts, emoji) => this.pinnedMessages.updateTopicTitle(ts, emoji),
      pinThreadMessage: (s, html) => this.pinnedMessages.pinThreadMessage(s, html),
      updatePinnedSplitStatus: (p) => this.pinnedMessages.updatePinnedSplitStatus(p),
      updatePinnedDagStatus: (p, g) => this.pinnedMessages.updatePinnedDagStatus(p, g),
      broadcastSession: (s, e, st) => this.broadcastSession(s, e, st),
      broadcastSessionDeleted: (slug) => this.broadcastSessionDeleted(slug),
      broadcastDag: (g, e) => this.broadcastDag(g, e),
      broadcastDagDeleted: (id) => this.broadcastDagDeleted(id),
      closeChildSessions: (p) => this.closeChildSessions(p),
      closeSingleChild: (c) => this.closeSingleChild(c),
      startWithProfileSelection: (repo, task, mode, threadId, photos, autoAdv) =>
        this.startWithProfileSelection(repo, task, mode, threadId, photos, autoAdv),
      startDag: (ts, items, isStack) => this.dagOrchestrator.startDag(ts, items, isStack),
      shipAdvanceToVerification: (ts, g) => this.shipPipeline.shipAdvanceToVerification(ts, g),
      handleLandCommand: (ts) => this.landingManager.handleLandCommand(ts),
      handleShipAdvance: (ts) => this.shipPipeline.handleShipAdvance(ts),
      shipAdvanceToDag: (ts) => this.shipPipeline.shipAdvanceToDag(ts),
      handleExecuteCommand: (ts, d) => this.commandHandler.handleExecuteCommand(ts, d),
      notifyParentOfChildComplete: (cs, s) => this.notifyParentOfChildComplete(cs, s),
      handleTopicFeedback: (ts, fb) => this.handleTopicFeedback(ts, fb),
      postSessionDigest: (ts, pr) => { this.postSessionDigest(ts, pr).catch(() => {}) },
      runDeferredBabysit: (id) => this.ciBabysitter.runDeferredBabysit(id),
      queueDeferredBabysit: (id, entry) => this.ciBabysitter.queueDeferredBabysit(id, entry),
      babysitPR: (ts, pr, qr) => this.ciBabysitter.babysitPR(ts, pr, qr),
      babysitDagChildCI: (cs, pr) => this.ciBabysitter.babysitDagChildCI(cs, pr),
      updateDagPRDescriptions: (g, cwd) => this.dagOrchestrator.updateDagPRDescriptions(g, cwd),
      scheduleDagNodes: (ts, g, isStack) => this.dagOrchestrator.scheduleDagNodes(ts, g, isStack),
      spawnSplitChild: (p, item, all) => this.spawnSplitChild(p, item, all),
      spawnDagChild: (p, g, n, s) => this.dagOrchestrator.spawnDagChild(p, g, n, s),
    }
  }

  // ── Conversation & broadcast helpers ──────────────────────────────────

  private pushToConversation(session: TopicSession, message: TopicMessage): void {
    session.conversation.push(message)
    const { conversation, truncated, truncatedCount } = truncateConversation(
      session.conversation,
      this.config.workspace.maxConversationLength,
    )
    if (truncated) {
      session.conversation = conversation
      log.info({ slug: session.slug, truncatedCount }, "truncated conversation")
    }
  }

  private broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void {
    if (!this.broadcaster) return
    const apiSession = topicSessionToApi(session, this.config.telegram.chatId, session.activeSessionId, sessionState)
    this.broadcaster.broadcast({ type: eventType, session: apiSession })
  }

  private broadcastSessionDeleted(slug: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "session_deleted", sessionId: slug })
  }

  private broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void {
    if (!this.broadcaster) return
    const apiDag = dagToApi(graph, this.topicSessions, this.sessions, this.config.telegram.chatId)
    this.broadcaster.broadcast({ type: eventType, dag: apiDag })
  }

  private broadcastDagDeleted(dagId: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "dag_deleted", dagId })
  }

  // ── Session persistence & lifecycle ───────────────────────────────────

  async loadPersistedSessions(): Promise<void> {
    const { active, expired, offset } = await this.store.load()
    this.offset = offset

    for (const [threadId, session] of active) {
      this.topicSessions.set(threadId, session)

      if (session.interruptedAt) {
        log.info({ slug: session.slug, threadId }, "session was interrupted, notifying")
        this.telegram.sendMessage(
          `⚡ This session was interrupted by a deploy. Send <b>/reply</b> to continue.`,
          threadId,
        ).catch((err) => {
          log.warn({ err, slug: session.slug }, "failed to notify interrupted session")
        })
        session.interruptedAt = undefined
      }
    }

    if (active.size > 0) {
      log.info({ count: active.size, offset }, "loaded persisted sessions")
    }
    if (expired.size > 0) {
      log.info({ count: expired.size }, "cleaning expired sessions")
      for (const [threadId, session] of expired) {
        await this.telegram.deleteForumTopic(threadId)
        await this.removeWorkspace(session)
        log.info({ slug: session.slug, threadId }, "cleaned expired session")
      }
    }
    const loadedDags = await this.dagStore.load()
    for (const [dagId, graph] of loadedDags) {
      this.dags.set(dagId, graph)
    }
    if (loadedDags.size > 0) {
      log.info({ count: loadedDags.size }, "loaded persisted DAGs")
      await this.reconcileDags()
    }

    this.pinnedMessages.updatePinnedSummary()
  }

  private async reconcileDags(): Promise<void> {
    for (const [dagId, graph] of this.dags) {
      let mutated = false

      for (const node of graph.nodes) {
        if (node.status === "running") {
          const childAlive = node.threadId != null &&
            this.topicSessions.get(node.threadId)?.activeSessionId != null
          if (!childAlive) {
            failNode(graph, node.id)
            node.error = "Session lost during restart"
            node.recoveryAttempted = false
            mutated = true
            log.warn({ dagId, nodeId: node.id }, "reconciled running node → failed (session dead)")
          }
        } else if (node.status === "ci-pending") {
          node.status = "ci-failed"
          node.error = "CI status unknown after restart"
          mutated = true
          log.warn({ dagId, nodeId: node.id }, "reconciled ci-pending node → ci-failed")
        }
      }

      if (mutated) {
        advanceDag(graph)

        const parent = this.topicSessions.get(graph.parentThreadId)
        if (parent) {
          this.telegram.sendMessage(
            `⚡ DAG recovered after restart — some nodes were transitioned. Use <code>/retry</code> to re-run failed nodes.\n\n${renderDagStatus(graph)}`,
            graph.parentThreadId,
          ).catch((err) => {
            log.warn({ err, dagId }, "failed to send DAG recovery notification")
          })
          this.pinnedMessages.updatePinnedDagStatus(parent, graph).catch(() => {})
        }

        this.broadcastDag(graph, "dag_updated")
      }
    }

    await this.persistDags()
  }

  async start(): Promise<void> {
    this.running = true
    log.info("started, polling Telegram")

    while (this.running) {
      await this.poll()
    }
  }

  stop(): void {
    this.running = false
    this.stopCleanupTimer()
    for (const { handle } of this.sessions.values()) {
      handle.interrupt()
    }
    this.persistTopicSessions(true).catch(() => {})
    log.info("stopped")
  }

  // ── Public command handlers (called by tests and external API) ────────

  async handleReplyCommand(threadId: number, text: string): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(`❌ No active session in thread ${threadId}`, threadId)
      return
    }
    await this.handleTopicFeedback(topicSession, text)
  }

  async handleStopCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    await this.handleStopCommandInternal(topicSession)
  }

  async handleCloseCommand(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      await this.telegram.sendMessage(`❌ Thread ${threadId} not found or no active session`, threadId)
      return
    }
    await this.handleCloseCommandInternal(topicSession)
  }

  // ── Cleanup timer ─────────────────────────────────────────────────────

  startCleanupTimer(): void {
    this.cleanupStaleSessions().catch((err) => {
      log.error({ err }, "startup cleanup error")
    })
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions().catch((err) => {
        log.error({ err }, "cleanup error")
      })
    }, this.config.workspace.cleanupIntervalMs)
    log.info({
      intervalMinutes: Math.round(this.config.workspace.cleanupIntervalMs / 60000),
      ttlDays: Math.round(this.config.workspace.staleTtlMs / 86400000),
    }, "cleanup timer started")
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now()
    const staleTtlMs = this.config.workspace.staleTtlMs
    const stale: [number, TopicSession][] = []

    for (const [threadId, session] of this.topicSessions) {
      if (session.activeSessionId) continue
      const staleTime = session.interruptedAt ?? session.lastActivityAt
      if (now - staleTime > staleTtlMs) {
        stale.push([threadId, session])
      }
    }

    if (stale.length === 0) return

    log.info({ count: stale.length }, "cleaning up stale sessions")

    for (const [threadId, session] of stale) {
      if (session.dagId) {
        this.dags.delete(session.dagId)
        this.broadcastDagDeleted(session.dagId)
      }
      await this.closeChildSessions(session)
      await this.telegram.deleteForumTopic(threadId)
      await this.removeWorkspace(session)
      this.topicSessions.delete(threadId)
      log.info({ slug: session.slug, threadId }, "cleaned up stale session")
    }

    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
  }

  private async persistTopicSessions(markInterrupted = false): Promise<void> {
    const toSave = new Map<number, TopicSession>()
    const now = Date.now()
    for (const [threadId, session] of this.topicSessions) {
      if (markInterrupted && session.activeSessionId) {
        toSave.set(threadId, {
          ...session,
          activeSessionId: undefined,
          interruptedAt: now,
        })
      } else {
        toSave.set(threadId, session)
      }
    }
    await this.store.save(toSave, this.offset)
    await this.dagStore.save(this.dags)
  }

  private async persistDags(): Promise<void> {
    await this.dagStore.save(this.dags)
  }

  // ── Polling & update handling ─────────────────────────────────────────

  private async poll(): Promise<void> {
    const updates = await this.telegram.getUpdates(this.offset, POLL_TIMEOUT)

    for (const update of updates) {
      try {
        await this.handleUpdate(update)
      } catch (err) {
        log.error({ err, updateId: update.update_id }, "error handling update")
        captureException(err, { updateId: update.update_id })
      }
    }

    if (updates.length > 0) {
      this.offset = Math.max(...updates.map((u) => u.update_id)) + 1
      await this.persistTopicSessions()
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query)
      return
    }

    const message = update.message
    if (!message) return
    if (message.chat.id.toString() !== this.config.telegram.chatId) return

    const userId = message.from?.id ?? -1
    if (!this.config.telegram.allowedUserIds.includes(userId)) return

    const text = (message.text ?? message.caption)?.trim()
    const photos = message.photo
    if (!text && !photos) return

    const threadId = message.message_thread_id
    const topicSession = threadId !== undefined ? this.topicSessions.get(threadId) : undefined

    const routed = routeCommand(text, threadId, topicSession?.mode, !!topicSession, photos)

    if (!routed) {
      if (threadId !== undefined) {
        const session = this.sessions.get(threadId)
        if (session) {
          log.debug({ threadId }, "received message in active topic, session still initializing")
        }
      }
      return
    }

    switch (routed.type) {
      case "status": return this.commandHandler.handleStatusCommand()
      case "stats": return this.commandHandler.handleStatsCommand()
      case "usage": return this.commandHandler.handleUsageCommand()
      case "clean": return this.commandHandler.handleCleanCommand()
      case "help": return this.commandHandler.handleHelpCommand()
      case "config": return this.commandHandler.handleConfigCommand(routed.args)
      case "task": return this.commandHandler.handleTaskCommand(routed.args, routed.threadId, routed.photos)
      case "plan": return this.handlePlanCommand(routed.args, routed.threadId, routed.photos)
      case "think": return this.handleThinkCommand(routed.args, routed.threadId, routed.photos)
      case "review": return this.commandHandler.handleReviewCommand(routed.args, routed.threadId)
      case "ship": return this.handleShipCommand(routed.args, routed.threadId)
      case "close": return this.handleCloseCommandInternal(topicSession!)
      case "stop": return this.handleStopCommandInternal(topicSession!)
      case "execute": return this.commandHandler.handleExecuteCommand(topicSession!, routed.directive)
      case "split": return this.splitOrchestrator.handleSplitCommand(topicSession!, routed.directive)
      case "stack": return this.splitOrchestrator.handleStackCommand(topicSession!, routed.directive)
      case "dag": return this.commandHandler.handleDagCommand(topicSession!, routed.directive)
      case "judge": return this.judgeOrchestrator.handleJudgeCommand(topicSession!, routed.directive)
      case "done": return this.commandHandler.handleDoneCommand(topicSession!)
      case "land": return this.landingManager.handleLandCommand(topicSession!)
      case "retry": return this.dagOrchestrator.handleRetryCommand(topicSession!, routed.nodeId)
      case "force": return this.dagOrchestrator.handleForceCommand(topicSession!, routed.nodeId)
      case "reply": return this.handleTopicFeedback(topicSession!, routed.text, routed.photos)
    }
  }

  // ── Callback queries ──────────────────────────────────────────────────

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!this.config.telegram.allowedUserIds.includes(query.from.id)) {
      await this.telegram.answerCallbackQuery(query.id, "Not authorized")
      return
    }

    const data = query.data
    if (!data) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    if (data.startsWith("profile:")) {
      await this.handleProfileCallback(query, data.slice("profile:".length))
      return
    }

    if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:") && !data.startsWith("review-repo:") && !data.startsWith("ship-repo:")) {
      await this.telegram.answerCallbackQuery(query.id)
      return
    }

    const isThink = data.startsWith("think-repo:")
    const isPlan = data.startsWith("plan-repo:")
    const isReview = data.startsWith("review-repo:")
    const isShip = data.startsWith("ship-repo:")
    const repoSlug = isThink
      ? data.slice("think-repo:".length)
      : isPlan
      ? data.slice("plan-repo:".length)
      : isReview
      ? data.slice("review-repo:".length)
      : isShip
      ? data.slice("ship-repo:".length)
      : data.slice("repo:".length)
    const repoUrl = this.config.repos[repoSlug]
    if (!repoUrl) {
      await this.telegram.answerCallbackQuery(query.id, "Unknown repo")
      return
    }

    const messageId = query.message?.message_id

    if (messageId) {
      const pending = this.pendingTasks.get(messageId)
      if (pending) {
        this.pendingTasks.delete(messageId)
        await this.telegram.answerCallbackQuery(query.id, `Selected: ${repoSlug}`)
        await this.telegram.deleteMessage(messageId)

        pending.repoSlug = repoSlug
        pending.repoUrl = repoUrl
        if (pending.mode === "review" && !pending.task) {
          pending.task = buildReviewAllTask(repoUrl)
        }

        const defaultProfileId = this.profileStore.getDefaultId()
        if (defaultProfileId) {
          await this.startTopicSession(repoUrl, pending.task, pending.mode, undefined, defaultProfileId, pending.autoAdvance)
        } else {
          const profiles = this.profileStore.list()
          if (profiles.length > 1) {
            const label = pending.mode === "ship-think" ? "ship" : pending.mode
            const keyboard = buildProfileKeyboard(profiles)
            const msgId = await this.telegram.sendMessageWithKeyboard(
              `Pick a profile for ${label}: <i>${escapeHtml(pending.task)}</i>`,
              keyboard,
              pending.threadId,
            )
            if (msgId) {
              this.pendingProfiles.set(msgId, pending)
            }
          } else {
            await this.startTopicSession(repoUrl, pending.task, pending.mode, undefined, undefined, pending.autoAdvance)
          }
        }
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  private async handleProfileCallback(query: TelegramCallbackQuery, profileId: string): Promise<void> {
    const profile = this.profileStore.get(profileId)
    if (!profile) {
      await this.telegram.answerCallbackQuery(query.id, "Unknown profile")
      return
    }

    const messageId = query.message?.message_id
    if (messageId) {
      const pending = this.pendingProfiles.get(messageId)
      if (pending) {
        this.pendingProfiles.delete(messageId)
        await this.telegram.answerCallbackQuery(query.id, `Selected: ${profile.name}`)
        await this.telegram.deleteMessage(messageId)
        await this.startTopicSession(pending.repoUrl, pending.task, pending.mode, undefined, profileId, pending.autoAdvance)
        return
      }
    }

    await this.telegram.answerCallbackQuery(query.id)
  }

  // ── Session-creating commands ─────────────────────────────────────────

  private async handlePlanCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(`Usage: <code>/plan [repo] description of what to plan</code>`, replyThreadId)
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "plan")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for plan: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "plan" })
        }
        return
      }
    }

    await this.startWithProfileSelection(repoUrl, task, "plan", replyThreadId, photos)
  }

  private async handleThinkCommand(args: string, replyThreadId?: number, photos?: TelegramPhotoSize[]): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(`Usage: <code>/think [repo] question or topic to research</code>`, replyThreadId)
      }
      return
    }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "think")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for research: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "think" })
        }
        return
      }
    }

    await this.startWithProfileSelection(repoUrl, task, "think", replyThreadId, photos)
  }

  private async handleShipCommand(args: string, replyThreadId?: number): Promise<void> {
    const { repoUrl, task } = parseTaskArgs(this.config.repos, args)

    if (!task) {
      if (replyThreadId !== undefined) {
        await this.telegram.sendMessage(
          `Usage: <code>/ship [repo] description of the feature to build</code>`,
          replyThreadId,
        )
      }
      return
    }

    const autoAdvance: AutoAdvance = { phase: "think", featureDescription: task, autoLand: false }

    if (!repoUrl) {
      const repoKeys = Object.keys(this.config.repos)
      if (repoKeys.length > 0) {
        const keyboard = buildRepoKeyboard(repoKeys, "ship")
        const msgId = await this.telegram.sendMessageWithKeyboard(
          `Pick a repo for ship: <i>${escapeHtml(task)}</i>`,
          keyboard,
          replyThreadId,
        )
        if (msgId) {
          this.pendingTasks.set(msgId, { task, threadId: replyThreadId, mode: "ship-think", autoAdvance })
        }
        return
      }
    }

    await this.startWithProfileSelection(repoUrl, task, "ship-think", replyThreadId, undefined, autoAdvance)
  }

  private async startWithProfileSelection(
    repoUrl: string | undefined,
    task: string,
    mode: "task" | "plan" | "think" | "review" | "ship-think",
    replyThreadId?: number,
    photos?: TelegramPhotoSize[],
    autoAdvance?: AutoAdvance,
  ): Promise<void> {
    const defaultProfileId = this.profileStore.getDefaultId()
    if (defaultProfileId) {
      await this.startTopicSession(repoUrl, task, mode, photos, defaultProfileId, autoAdvance)
      return
    }

    const profiles = this.profileStore.list()
    if (profiles.length > 1) {
      const keyboard = buildProfileKeyboard(profiles)
      const label = mode === "ship-think" ? "ship" : mode
      const msgId = await this.telegram.sendMessageWithKeyboard(
        `Pick a profile for ${label}: <i>${escapeHtml(task)}</i>`,
        keyboard,
        replyThreadId,
      )
      if (msgId) {
        this.pendingProfiles.set(msgId, { task, threadId: replyThreadId, repoUrl, mode, autoAdvance })
      }
      return
    }

    await this.startTopicSession(repoUrl, task, mode, photos, undefined, autoAdvance)
  }

  // ── Topic session creation ────────────────────────────────────────────

  private async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: SessionMode,
    photos?: TelegramPhotoSize[],
    profileId?: string,
    autoAdvance?: AutoAdvance,
  ): Promise<void> {
    return this.sessionLifecycle.startTopicSession(repoUrl, task, mode, photos, profileId, autoAdvance)
  }

  private async updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void> {
    const handle = topicSession.topicHandle ?? topicSession.slug
    const name = `${stateEmoji} ${handle}`
    await this.telegram.editForumTopic(topicSession.threadId, name).catch(() => {})
  }

  // ── Agent spawning ────────────────────────────────────────────────────

  private async spawnTopicAgent(topicSession: TopicSession, task: string, mcpOverrides?: Partial<McpConfig>, systemPromptOverride?: string): Promise<void> {
    return this.sessionLifecycle.spawnTopicAgent(topicSession, task, mcpOverrides, systemPromptOverride)
  }

  private async spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void> {
    return this.sessionLifecycle.spawnCIFixAgent(topicSession, task, onComplete)
  }

  // ── Feedback & commands that stay in Dispatcher ───────────────────────

  private async handleTopicFeedback(topicSession: TopicSession, feedback: string, photos?: TelegramPhotoSize[]): Promise<void> {
    if (topicSession.activeSessionId) {
      topicSession.pendingFeedback.push(feedback)
      await this.telegram.sendMessage(
        `📝 Reply queued — will be applied when the current iteration finishes.`,
        topicSession.threadId,
      )
      return
    }

    const imagePaths = await this.downloadPhotos(photos)
    const fullFeedback = appendImageContext(feedback, imagePaths)

    this.pushToConversation(topicSession, {
      role: "user",
      text: fullFeedback,
      images: imagePaths.length > 0 ? imagePaths : undefined,
    })

    const iteration = Math.floor(topicSession.conversation.filter((m) => m.role === "user").length)

    if (topicSession.mode === "think") {
      await this.telegram.sendMessage(formatThinkIteration(topicSession.slug, iteration), topicSession.threadId)
    } else if (topicSession.mode === "review") {
      await this.telegram.sendMessage(formatReviewIteration(topicSession.slug, iteration), topicSession.threadId)
    } else if (topicSession.mode === "plan") {
      await this.telegram.sendMessage(formatPlanIteration(topicSession.slug, iteration), topicSession.threadId)
    } else {
      await this.telegram.sendMessage(formatFollowUpIteration(topicSession.slug, iteration), topicSession.threadId)
    }

    const contextTask = buildContextPrompt(topicSession)
    await this.spawnTopicAgent(topicSession, contextTask)
  }

  // ── Parent/child notification ─────────────────────────────────────────

  private async notifyParentOfChildComplete(
    childSession: TopicSession,
    state: string,
  ): Promise<void> {
    if (!childSession.parentThreadId) return

    if (childSession.dagId && childSession.dagNodeId) {
      await this.dagOrchestrator.onDagChildComplete(childSession, state)
      return
    }

    await this.splitOrchestrator.notifyParentOfChildComplete(childSession, state)
  }

  // ── Split child spawning (context implementation) ─────────────────────

  private async spawnSplitChild(
    parent: TopicSession,
    item: { title: string; description: string },
    allItems: { title: string; description: string }[],
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const childLabel = taskToLabel(item.title)
    const topicHandle = `${parent.slug}/${childLabel}`
    const topicName = `⚡ ${topicHandle}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create child topic for split")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug })
      return null
    }

    const threadId = topic.message_thread_id

    const cwd = await this.prepareWorkspace(slug, parent.repoUrl)
    if (!cwd) {
      await this.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.telegram.deleteForumTopic(threadId)
      return null
    }

    const task = buildSplitChildPrompt(parent.conversation, item, allItems)

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      topicHandle,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: item.title,
      branch: parent.repoUrl ? `minion/${slug}` : undefined,
    }

    this.topicSessions.set(threadId, childSession)
    this.broadcastSession(childSession, "session_created")

    await this.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  // ── Conversation utilities ────────────────────────────────────────────

  private extractPRFromConversation(topicSession: TopicSession): string | null {
    for (let i = topicSession.conversation.length - 1; i >= 0; i--) {
      const msg = topicSession.conversation[i]
      if (msg.role === "assistant") {
        const url = extractPRUrl(msg.text)
        if (url) return url
      }
    }
    return null
  }

  private async postSessionDigest(topicSession: TopicSession, prUrl: string): Promise<void> {
    const summaryPath = path.join(topicSession.cwd, ".session-summary.md")
    if (fs.existsSync(summaryPath)) return

    let digest: string | null
    if (topicSession.parentThreadId) {
      const parentSession = this.topicSessions.get(topicSession.parentThreadId)
      const profile = topicSession.profileId
        ? this.profileStore.get(topicSession.profileId)
        : undefined
      digest = await buildChildSessionDigest({
        childConversation: topicSession.conversation,
        parentConversation: parentSession?.conversation,
        profile,
      })
    } else {
      digest = buildConversationDigest(topicSession.conversation)
    }
    if (!digest) return

    try {
      execSync(`gh pr comment "${prUrl}" --body-file -`, {
        input: digest,
        cwd: topicSession.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      log.error({ err }, "failed to post session digest")
    }
  }

  // ── Child session management ──────────────────────────────────────────

  private async closeChildSessions(parent: TopicSession): Promise<void> {
    const childrenToClose = new Map<number, TopicSession>()

    if (parent.childThreadIds) {
      for (const childId of parent.childThreadIds) {
        const child = this.topicSessions.get(childId)
        if (child) childrenToClose.set(childId, child)
      }
    }

    for (const [candidateId, candidate] of this.topicSessions) {
      if (candidate.parentThreadId !== undefined &&
          candidate.parentThreadId === parent.threadId &&
          !childrenToClose.has(candidateId)) {
        childrenToClose.set(candidateId, candidate)
      }
    }

    if (childrenToClose.size > 10) {
      log.warn(
        { count: childrenToClose.size, parentThreadId: parent.threadId, parentSlug: parent.slug },
        "Unusually high number of children to close - possible bug?",
      )
    }

    await Promise.all([...childrenToClose.values()].map((child) => this.closeSingleChild(child)))

    parent.childThreadIds = []
  }

  private async closeSingleChild(child: TopicSession): Promise<void> {
    const childId = child.threadId

    if (child.activeSessionId) {
      const childActive = this.sessions.get(childId)
      this.sessions.delete(childId)
      if (childActive) await childActive.handle.kill().catch(() => {})
    }
    this.topicSessions.delete(childId)
    this.broadcastSessionDeleted(child.slug)
    await this.telegram.deleteForumTopic(childId).catch(() => {})
    await this.removeWorkspace(child).catch(() => {})
    log.info({ slug: child.slug, threadId: childId }, "closed child topic")
  }

  private async handleCloseCommandInternal(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    await this.closeChildSessions(topicSession)

    if (topicSession.dagId) {
      this.broadcastDagDeleted(topicSession.dagId)
      this.dags.delete(topicSession.dagId)
    }

    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
    await this.telegram.deleteForumTopic(threadId)
    log.info({ slug: topicSession.slug, threadId }, "closed and deleted topic")

    if (topicSession.activeSessionId) {
      const activeSession = this.sessions.get(threadId)
      this.sessions.delete(threadId)
      if (activeSession) {
        activeSession.handle.kill().then(
          () => this.removeWorkspace(topicSession),
          () => this.removeWorkspace(topicSession),
        ).catch((err) => {
          log.error({ err, slug: topicSession.slug }, "background cleanup failed")
        })
        return
      }
    }

    this.removeWorkspace(topicSession).catch((err) => {
      log.error({ err, slug: topicSession.slug }, "background cleanup failed")
    })
  }

  private async handleStopCommandInternal(topicSession: TopicSession): Promise<void> {
    const threadId = topicSession.threadId

    if (!topicSession.activeSessionId) {
      await this.telegram.sendMessage(`⚠️ No active session to stop.`, threadId)
      return
    }

    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      this.sessions.delete(threadId)
      await activeSession.handle.kill()
    }

    topicSession.activeSessionId = undefined
    topicSession.pendingFeedback = []
    this.persistTopicSessions()

    await this.telegram.sendMessage(`⏹️ Session stopped. Send <b>/reply</b> to continue.`, threadId)
    log.info({ slug: topicSession.slug, threadId }, "stopped session")
  }

  // ── Token management ──────────────────────────────────────────────────

  private async refreshGitToken(): Promise<void> {
    await this.tokenProvider?.refreshEnv()
  }

  // ── Workspace wrappers ────────────────────────────────────────────────

  private async prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null> {
    await this.refreshGitToken()
    return prepareWorkspace(slug, this.config.workspace.root, repoUrl, startBranch)
  }

  private async removeWorkspace(topicSession: TopicSession): Promise<void> {
    return removeWorkspace(topicSession, this.config.workspace.root)
  }

  private cleanBuildArtifacts(cwd: string): void {
    cleanBuildArtifacts(cwd)
  }

  private async prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null> {
    await this.refreshGitToken()
    return prepareFanInBranch(slug, repoUrl, upstreamBranches, this.config.workspace.root)
  }

  private async downloadPhotos(photos: TelegramPhotoSize[] | undefined): Promise<string[]> {
    return downloadPhotos(photos, this.telegram)
  }

  private mergeUpstreamBranches(workDir: string, additionalBranches: string[]) {
    return mergeUpstreamBranches(workDir, additionalBranches)
  }

  // ── API accessors ─────────────────────────────────────────────────────

  activeSessions(): number {
    return this.sessions.size
  }

  getSessions(): Map<number, { handle: SessionHandle; meta: SessionMeta; task: string }> {
    return this.sessions
  }

  getTopicSessions(): Map<number, TopicSession> {
    return this.topicSessions
  }

  getDags(): Map<string, DagGraph> {
    return this.dags
  }

  getSessionState(threadId: number): SessionState | undefined {
    const session = this.sessions.get(threadId)
    return session?.handle.getState()
  }

  async apiSendReply(threadId: number, message: string): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      throw new SessionNotFoundError(threadId, Array.from(this.topicSessions.keys()))
    }
    topicSession.pendingFeedback.push(message)
  }

  apiStopSession(threadId: number): void {
    const session = this.sessions.get(threadId)
    if (session) {
      session.handle.interrupt()
    }
  }

  async apiCloseSession(threadId: number): Promise<void> {
    const topicSession = this.topicSessions.get(threadId)
    if (!topicSession) {
      throw new SessionNotFoundError(threadId, Array.from(this.topicSessions.keys()))
    }

    const activeSession = this.sessions.get(threadId)
    if (activeSession) {
      activeSession.handle.interrupt()
      this.sessions.delete(threadId)
    }

    await this.telegram.deleteForumTopic(threadId)
    await this.removeWorkspace(topicSession)
    this.topicSessions.delete(threadId)
    this.broadcastSessionDeleted(topicSession.slug)
    await this.persistTopicSessions()
    this.pinnedMessages.updatePinnedSummary()
  }
}

import path from "node:path"
import fs from "node:fs"
import type { TelegramClient } from "../telegram.js"
import type { TopicSession, TopicMessage } from "../types.js"
import { escapeHtml } from "../command-parser.js"
import { formatPinnedSplitStatus, formatPinnedDagStatus } from "../format.js"
import type { MinionConfig } from "../config-types.js"
import type { DagGraph } from "../dag.js"
import type { QualityReport } from "../quality-gates.js"
import type { ActiveSession, PendingTask } from "../session-manager.js"
import { SessionStore } from "../store.js"
import { ProfileStore } from "../profile-store.js"
import { StatsTracker } from "../stats.js"
import { StateBroadcaster, topicSessionToApi, dagToApi } from "../api-server.js"
import { truncateConversation } from "../conversation-limits.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

export class SessionRegistry {
  readonly sessions = new Map<number, ActiveSession>()
  readonly topicSessions = new Map<number, TopicSession>()
  readonly pendingTasks = new Map<number, PendingTask>()
  readonly pendingProfiles = new Map<number, PendingTask>()
  readonly dags = new Map<string, DagGraph>()
  readonly pendingBabysitPRs = new Map<number, Array<{ childSession: TopicSession; prUrl: string; qualityReport?: QualityReport }>>()
  readonly store: SessionStore
  readonly profileStore: ProfileStore
  readonly stats: StatsTracker
  pinnedSummaryMessageId: number | null = null

  private readonly broadcaster?: StateBroadcaster

  constructor(
    private readonly telegram: TelegramClient,
    private readonly config: MinionConfig,
    broadcaster?: StateBroadcaster,
  ) {
    this.broadcaster = broadcaster
    this.store = new SessionStore(this.config.workspace.root)
    this.profileStore = new ProfileStore(this.config.workspace.root)
    this.stats = new StatsTracker(this.config.workspace.root)
    this.loadPinnedMessageId()
  }

  pushToConversation(session: TopicSession, message: TopicMessage): void {
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

  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void {
    if (!this.broadcaster) return
    const apiSession = topicSessionToApi(session, this.config.telegram.chatId, session.activeSessionId, sessionState)
    this.broadcaster.broadcast({ type: eventType, session: apiSession })
  }

  broadcastSessionDeleted(slug: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "session_deleted", sessionId: slug })
  }

  broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void {
    if (!this.broadcaster) return
    const apiDag = dagToApi(graph, this.topicSessions, this.sessions, this.config.telegram.chatId)
    this.broadcaster.broadcast({ type: eventType, dag: apiDag })
  }

  broadcastDagDeleted(dagId: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "dag_deleted", dagId })
  }

  async persistTopicSessions(offset: number, markInterrupted = false): Promise<void> {
    const toSave = new Map<number, TopicSession>()
    const now = Date.now()
    for (const [threadId, session] of this.topicSessions) {
      if (markInterrupted && session.activeSessionId) {
        // Mark as interrupted so we can notify on restart
        toSave.set(threadId, {
          ...session,
          activeSessionId: undefined,
          interruptedAt: now,
        })
      } else {
        toSave.set(threadId, session)
      }
    }
    await this.store.save(toSave, offset)
  }

  private get pinnedSummaryPath(): string {
    return path.join(this.config.workspace.root, ".pinned-summary.json")
  }

  loadPinnedMessageId(): void {
    try {
      const raw = fs.readFileSync(this.pinnedSummaryPath, "utf-8")
      const data = JSON.parse(raw) as { messageId?: number | null }
      this.pinnedSummaryMessageId = data.messageId ?? null
    } catch { /* file doesn't exist yet */ }
  }

  savePinnedMessageId(id: number | null): void {
    try {
      fs.writeFileSync(this.pinnedSummaryPath, JSON.stringify({ messageId: id }))
    } catch { /* ignore */ }
  }

  formatPinnedSummary(): string {
    const sessions = [...this.topicSessions.values()]
    if (sessions.length === 0) return "No active minion sessions."
    const lines = sessions.map((s) => {
      const taskText = s.conversation[0]?.text ?? ""
      const desc = taskText.length > 60 ? taskText.slice(0, 60).trimEnd() + "…" : taskText
      const icon = s.activeSessionId ? "⚡" : "💬"
      return `${icon} <b>${escapeHtml(s.slug)}</b>: ${escapeHtml(desc)} (${s.mode})`
    })
    return lines.join("\n")
  }

  updatePinnedSummary(): void {
    const html = this.formatPinnedSummary()
    ;(async () => {
      if (this.pinnedSummaryMessageId !== null) {
        const ok = await this.telegram.editMessage(this.pinnedSummaryMessageId, html)
        if (ok) return
        this.pinnedSummaryMessageId = null
        this.savePinnedMessageId(null)
      }
      const { ok, messageId } = await this.telegram.sendMessage(html)
      if (ok && messageId !== null) {
        await this.telegram.pinChatMessage(messageId)
        this.pinnedSummaryMessageId = messageId
        this.savePinnedMessageId(messageId)
      }
    })().catch((err) => {
      log.error({ err }, "updatePinnedSummary error")
    })
  }

  /** Pin a message in a thread, updating any previously pinned message. */
  async pinThreadMessage(session: TopicSession, html: string): Promise<void> {
    const threadId = session.threadId
    try {
      // If we have an existing pinned message, update it
      if (session.pinnedMessageId != null) {
        const ok = await this.telegram.editMessage(session.pinnedMessageId, html, threadId)
        if (ok) return
        // Edit failed, create new message
        session.pinnedMessageId = undefined
      }

      // Send new message and pin it
      const { ok, messageId } = await this.telegram.sendMessage(html, threadId)
      if (ok && messageId != null) {
        await this.telegram.pinChatMessage(messageId)
        session.pinnedMessageId = messageId
      }
    } catch (err) {
      log.warn({ err, slug: session.slug }, "pinThreadMessage error")
    }
  }

  /** Update the pinned split status in a parent thread showing all children with PR links. */
  async updatePinnedSplitStatus(parent: TopicSession): Promise<void> {
    if (!parent.childThreadIds || parent.childThreadIds.length === 0) return

    const children: { slug: string; label: string; prUrl?: string; status: "running" | "done" | "failed" }[] = []

    for (const id of parent.childThreadIds) {
      const child = this.topicSessions.get(id)
      if (!child) continue
      children.push({
        slug: child.slug,
        label: child.splitLabel ?? child.slug,
        prUrl: child.prUrl,
        status: child.activeSessionId ? "running" : child.prUrl ? "done" : "failed",
      })
    }

    if (children.length === 0) return

    const html = formatPinnedSplitStatus(parent.slug, parent.repo, children)
    await this.pinThreadMessage(parent, html)
  }

  /** Update the pinned DAG status in a parent thread showing all nodes with PR links. */
  async updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void> {
    const isStack = !graph.nodes.some((n) => n.dependsOn.length > 1) &&
      graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)

    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      prUrl: n.prUrl,
      status: n.status as "pending" | "ready" | "running" | "done" | "failed",
    }))

    const html = formatPinnedDagStatus(parent.slug, parent.repo, nodes, isStack)
    await this.pinThreadMessage(parent, html)
  }
}

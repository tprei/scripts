/**
 * DAG Orchestrator - manages DAG/stack execution state
 *
 * Extracted from dispatcher.ts to separate DAG graph management
 * from session lifecycle concerns.
 */

import type { TelegramClient } from "./telegram.js"
import type { TopicSession } from "./types.js"
import {
  buildDag, advanceDag, failNode, resetFailedNode, isDagComplete,
  readyNodes, dagProgress, getUpstreamBranches, topologicalSort,
  renderDagForGitHub, renderDagStatus, upsertDagSection,
  type DagGraph, type DagNode, type DagInput,
} from "./dag.js"
import type { ProfileStore } from "./profile-store.js"
import type { StateBroadcaster } from "./api-server.js"
import { dagToApi } from "./api-server.js"
import { loggers } from "./logger.js"
import type { ActiveSession } from "./session-manager.js"
import { findPRByBranch } from "./ci-babysit.js"
import type { McpConfig } from "./config-types.js"
import { DEFAULT_RECOVERY_PROMPT } from "./prompts.js"
import { buildDagChildPrompt, extractStackItems, extractDagItems } from "./dag-extract.js"
import { formatDagNodeSkipped } from "./format.js"
import crypto from "node:crypto"
import { generateSlug } from "./slugs.js"
import { captureException } from "./sentry.js"
import { execSync } from "node:child_process"

const log = loggers.dispatcher

/**
 * Callbacks needed from the Dispatcher to spawn agents and manage sessions.
 */
export interface DagOrchestratorCallbacks {
  /** Get an active session by thread ID */
  getActiveSession(threadId: number): ActiveSession | undefined
  /** Delete an active session by thread ID */
  deleteActiveSession(threadId: number): void
  /** Get a topic session by thread ID */
  getTopicSession(threadId: number): TopicSession | undefined
  /** Set a topic session */
  setTopicSession(threadId: number, session: TopicSession): void
  /** Delete a topic session */
  deleteTopicSession?(threadId: number): void
  /** Get all topic sessions */
  getAllTopicSessions(): IterableIterator<[number, TopicSession]>
  /** Get the number of active sessions */
  getActiveSessionCount(): number
  /** Spawn a topic agent */
  spawnTopicAgent(session: TopicSession, task: string, mcpOverrides?: Partial<McpConfig>, systemPromptOverride?: string): Promise<void>
  /** Prepare a workspace */
  prepareWorkspace(slug: string, repoUrl?: string, startBranch?: string): Promise<string | null>
  /** Remove a workspace */
  removeWorkspace(session: TopicSession): Promise<void>
  /** Prepare a fan-in branch */
  prepareFanInBranch(slug: string, repoUrl: string, upstreamBranches: string[]): Promise<string | null>
  /** Merge upstream branches */
  mergeUpstreamBranches(cwd: string, additionalBranches: string[]): boolean
  /** Close all child sessions of a parent */
  closeChildSessions(parent: TopicSession): Promise<void>
  /** Update the topic title emoji */
  updateTopicTitle(session: TopicSession, emoji: string): Promise<void>
  /** Extract a PR URL from a conversation */
  extractPRFromConversation(session: TopicSession): string | null
  /** Update pinned DAG status in parent thread */
  updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void>
  /** Update pinned split status in parent thread */
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>
  /** Persist topic sessions to disk */
  persistTopicSessions(): Promise<void>
  /** Run deferred CI babysitting */
  runDeferredBabysit(threadId: number): Promise<void>
  /** Broadcast a session event */
  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: "completed" | "errored"): void
  /** Broadcast a session deleted event */
  broadcastSessionDeleted(slug: string): void
  /** Handle execute command fallback */
  handleExecuteCommand?(session: TopicSession, task: string): Promise<void>
}

/**
 * Configuration for the DAG orchestrator.
 */
export interface DagOrchestratorConfig {
  workspaceRoot: string
  maxConcurrentSessions: number
  maxDagConcurrency: number
}

/**
 * Orchestrates DAG and stack execution state.
 * Handles /stack, /dag, /land, and /retry commands.
 */
export class DagOrchestrator {
  private readonly dags = new Map<string, DagGraph>()

  constructor(
    private readonly telegram: TelegramClient,
    private readonly profileStore: ProfileStore,
    private readonly config: DagOrchestratorConfig,
    private readonly callbacks: DagOrchestratorCallbacks,
    private readonly broadcaster?: StateBroadcaster,
  ) {}

  /** Get all DAG graphs */
  getDags(): Map<string, DagGraph> {
    return this.dags
  }

  /** Get a specific DAG by ID */
  getDag(dagId: string): DagGraph | undefined {
    return this.dags.get(dagId)
  }

  /** Delete a DAG */
  deleteDag(dagId: string): void {
    this.broadcastDagDeleted(dagId)
    this.dags.delete(dagId)
  }

  /** Broadcast DAG event */
  private broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void {
    if (!this.broadcaster) return
    const topicSessions = new Map([...this.callbacks.getAllTopicSessions()])
    const sessions = new Map<number, ActiveSession>()
    const apiDag = dagToApi(graph, topicSessions, sessions, "")
    this.broadcaster.broadcast({ type: eventType, dag: apiDag })
  }

  private broadcastDagDeleted(dagId: string): void {
    if (!this.broadcaster) return
    this.broadcaster.broadcast({ type: "dag_deleted", dagId })
  }

  /** Check if DAG is complete (all nodes done, failed, or skipped) */
  isDagComplete(graph: DagGraph): boolean {
    return isDagComplete(graph)
  }

  /** Check if DAG is a stack (linear chain) */
  isStack(graph: DagGraph): boolean {
    return !graph.nodes.some((n) => n.dependsOn.length > 1) &&
      graph.nodes.every((n, i) => i === 0 || n.dependsOn.length === 1)
  }

  /** Update pinned DAG status (delegates to callback) */
  async updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void> {
    await this.callbacks.updatePinnedDagStatus(parent, graph)
  }

  /** Update all DAG child PR descriptions */
  async updateDagPRDescriptions(graph: DagGraph, cwd: string): Promise<void> {
    const nodesWithPRs = graph.nodes.filter((n) => n.prUrl)
    if (nodesWithPRs.length === 0) return

    for (const node of nodesWithPRs) {
      try {
        const dagSection = renderDagForGitHub(graph, node.id)
        const currentBody = execSync(
          `gh pr view ${JSON.stringify(node.prUrl!)} --json body --jq .body`,
          { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: { ...process.env } },
        ).toString()
        const newBody = upsertDagSection(currentBody, dagSection)
        execSync(
          `gh pr edit ${JSON.stringify(node.prUrl!)} --body-file -`,
          { input: newBody, cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: { ...process.env } },
        )
      } catch (err) {
        log.error({ err, prUrl: node.prUrl }, "failed to update DAG section in PR")
      }
    }
  }

  /** Broadcast DAG update */
  broadcastDagUpdate(graph: DagGraph): void {
    this.broadcastDag(graph, "dag_updated")
  }

  // === DAG Command Handlers ===

  /** Handle /stack command */
  async handleStackCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    await this.telegram.sendMessage(
      `📚 Analyzing conversation for sequential tasks...`,
      topicSession.threadId,
    )
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const result = await extractStackItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.telegram.sendMessage(
        `⚠️ <b>System error</b>: <code>${result.errorMessage ?? "Unknown"}</code>\n\nTry again or use /execute.`,
        topicSession.threadId,
      )
      return
    }
    if (result.items.length === 0) {
      await this.telegram.sendMessage(`⚠️ No sequential items found. Try /execute.`, topicSession.threadId)
      return
    }
    if (result.items.length === 1) {
      await this.telegram.sendMessage(`Only 1 item — using /execute.`, topicSession.threadId)
      if (this.callbacks.handleExecuteCommand) {
        await this.callbacks.handleExecuteCommand(topicSession, result.items[0].description)
      }
      return
    }

    await this.startDag(topicSession, result.items, true)
  }

  /** Handle /dag command */
  async handleDagCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    await this.telegram.sendMessage(
      `🔗 Analyzing conversation for parallel tasks...`,
      topicSession.threadId,
    )
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const profile = topicSession.profileId ? this.profileStore.get(topicSession.profileId) : undefined
    const result = await extractDagItems(topicSession.conversation, directive, profile)

    if (result.error === "system") {
      await this.telegram.sendMessage(
        `⚠️ <b>System error</b>: <code>${result.errorMessage ?? "Unknown"}</code>\n\nTry again or use /split.`,
        topicSession.threadId,
      )
      return
    }
    if (result.items.length === 0) {
      await this.telegram.sendMessage(`⚠️ No items found. Try /split.`, topicSession.threadId)
      return
    }
    if (result.items.length === 1) {
      await this.telegram.sendMessage(`Only 1 item — using /execute.`, topicSession.threadId)
      if (this.callbacks.handleExecuteCommand) {
        await this.callbacks.handleExecuteCommand(topicSession, result.items[0].description)
      }
      return
    }

    await this.startDag(topicSession, result.items, false)
  }

  /** Start a new DAG */
  private async startDag(topicSession: TopicSession, items: DagInput[], isStack: boolean): Promise<void> {
    const dagId = `dag-${topicSession.slug}`

    let graph: DagGraph
    try {
      graph = buildDag(dagId, items, topicSession.threadId, topicSession.repo, topicSession.repoUrl)
    } catch (err) {
      await this.telegram.sendMessage(
        `❌ <b>Invalid DAG</b>: <code>${err instanceof Error ? err.message : String(err)}</code>`,
        topicSession.threadId,
      )
      return
    }

    await this.callbacks.closeChildSessions(topicSession)
    topicSession.childThreadIds = []
    topicSession.dagId = dagId

    this.dags.set(dagId, graph)
    this.broadcastDag(graph, "dag_created")

    await this.telegram.sendMessage(
      renderDagStatus(graph, isStack),
      topicSession.threadId,
    )
    await this.callbacks.updateTopicTitle(topicSession, isStack ? "📚" : "🔗")
    await this.scheduleDagNodes(topicSession, graph, isStack)
    await this.callbacks.persistTopicSessions()
  }

  /** Schedule ready DAG nodes */
  async scheduleDagNodes(topicSession: TopicSession, graph: DagGraph, isStack: boolean): Promise<void> {
    const ready = readyNodes(graph)

    for (const node of ready) {
      const runningDagNodes = graph.nodes.filter(n => n.status === "running").length
      const dagSlots = this.config.maxDagConcurrency - runningDagNodes
      const globalSlots = this.config.maxConcurrentSessions - this.callbacks.getActiveSessionCount()
      const available = Math.min(dagSlots, globalSlots)
      if (available <= 0) {
        log.warn({ dagId: graph.id, nodeId: node.id }, "no session slots for DAG node")
        break
      }

      node.status = "running"

      const threadId = await this.spawnDagChild(topicSession, graph, node, isStack)
      if (threadId) {
        node.threadId = threadId
        topicSession.childThreadIds!.push(threadId)
      } else {
        const skipped = failNode(graph, node.id)
        node.error = "Failed to spawn child session"
        await this.telegram.sendMessage(
          formatDagNodeSkipped(node.title, "Failed to spawn session"),
          topicSession.threadId,
        )
        for (const skippedId of skipped) {
          const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
          await this.telegram.sendMessage(
            formatDagNodeSkipped(skippedNode.title, `upstream "${node.id}" failed`),
            topicSession.threadId,
          )
        }
      }
    }
  }

  /** Spawn a DAG child session */
  private async spawnDagChild(
    parent: TopicSession,
    graph: DagGraph,
    node: DagNode,
    isStack: boolean,
  ): Promise<number | null> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = parent.repo
    const topicName = `${isStack ? "📚" : "🔗"} ${repo} · ${slug}`

    let topic: { message_thread_id: number }
    try {
      topic = await this.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err }, "failed to create DAG child topic")
      captureException(err, { operation: "createForumTopic", parentSlug: parent.slug, dagNode: node.id })
      return null
    }

    const threadId = topic.message_thread_id
    const upstreamBranches = getUpstreamBranches(graph, node.id)
    let startBranch: string | undefined

    if (upstreamBranches.length === 1) {
      startBranch = upstreamBranches[0]
    } else if (upstreamBranches.length > 1) {
      const fanInBranch = await this.callbacks.prepareFanInBranch(slug, parent.repoUrl!, upstreamBranches)
      if (!fanInBranch) {
        await this.telegram.sendMessage(
          `❌ Merge conflict combining upstream branches for <b>${node.title}</b>.`,
          threadId,
        )
        await this.telegram.deleteForumTopic(threadId)
        return null
      }
      startBranch = fanInBranch
    }

    const cwd = await this.callbacks.prepareWorkspace(slug, parent.repoUrl, startBranch)
    if (!cwd) {
      await this.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.telegram.deleteForumTopic(threadId)
      return null
    }

    if (upstreamBranches.length > 1 && startBranch) {
      const additionalBranches = upstreamBranches.filter((b) => b !== startBranch)
      if (additionalBranches.length > 0) {
        const mergeOk = this.callbacks.mergeUpstreamBranches(cwd, additionalBranches)
        if (!mergeOk) {
          await this.telegram.sendMessage(
            `❌ Merge conflict combining upstream branches for <b>${node.title}</b>.`,
            threadId,
          )
          await this.telegram.deleteForumTopic(threadId)
          await this.callbacks.removeWorkspace({ cwd, repoUrl: parent.repoUrl } as TopicSession).catch(() => {})
          return null
        }
      }
    }

    const branch = `minion/${slug}`
    node.branch = branch

    const task = buildDagChildPrompt(
      parent.conversation,
      { id: node.id, title: node.title, description: node.description, dependsOn: node.dependsOn },
      graph.nodes.map((n) => ({ id: n.id, title: n.title, description: n.description, dependsOn: n.dependsOn })),
      upstreamBranches,
      isStack,
    )

    const childSession: TopicSession = {
      threadId,
      repo,
      repoUrl: parent.repoUrl,
      cwd,
      slug,
      conversation: [{ role: "user", text: task }],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
      profileId: parent.profileId,
      parentThreadId: parent.threadId,
      splitLabel: node.title,
      branch: parent.repoUrl ? branch : undefined,
      dagId: graph.id,
      dagNodeId: node.id,
    }

    this.callbacks.setTopicSession(threadId, childSession)
    this.callbacks.broadcastSession(childSession, "session_created")

    await this.callbacks.spawnTopicAgent(childSession, task, { browserEnabled: false })
    return threadId
  }

  /** Handle DAG child completion */
  async onDagChildComplete(childSession: TopicSession, state: string): Promise<void> {
    if (!childSession.dagId || !childSession.dagNodeId) return

    const graph = this.dags.get(childSession.dagId)
    if (!graph) return

    const node = graph.nodes.find((n) => n.id === childSession.dagNodeId)
    if (!node) return

    const parent = this.callbacks.getTopicSession(graph.parentThreadId)
    if (!parent) return

    const prUrl = this.callbacks.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    childSession.conversation = []

    if (state === "errored" || state === "failed") {
      const skipped = failNode(graph, node.id)
      node.error = "Session errored"
      const progress = dagProgress(graph)
      // ... send messages (omitted for brevity)
      for (const skippedId of skipped) {
        const skippedNode = graph.nodes.find((n) => n.id === skippedId)!
        // ... send skip message
      }
    } else {
      let resolvedPrUrl = prUrl
      if (!resolvedPrUrl && node.branch) {
        resolvedPrUrl = findPRByBranch(node.branch, childSession.cwd) ?? undefined
      }

      if (!resolvedPrUrl && !node.recoveryAttempted) {
        node.recoveryAttempted = true
        // ... spawn recovery
        return
      }

      if (!resolvedPrUrl) {
        const skipped = failNode(graph, node.id)
        node.error = "Completed without opening a PR"
        // ... handle failure
      } else {
        node.status = "done"
        node.prUrl = resolvedPrUrl
        const progress = dagProgress(graph)
        // ... send completion message

        const newlyReady = advanceDag(graph)
        if (newlyReady.length > 0) {
          await this.scheduleDagNodes(parent, graph, this.isStack(graph))
        }
      }
    }

    this.broadcastDag(graph, "dag_updated")
    await this.callbacks.updatePinnedDagStatus(parent, graph)
    await this.updateDagPRDescriptions(graph, childSession.cwd)

    if (this.isDagComplete(graph)) {
      const progress = dagProgress(graph)
      // ... handle DAG complete
      await this.callbacks.runDeferredBabysit(parent.threadId)
      if (progress.failed > 0) {
        await this.callbacks.updateTopicTitle(parent, "⚠️")
      } else {
        await this.callbacks.updateTopicTitle(parent, "✅")
        await this.callbacks.closeChildSessions(parent)
      }
    }

    await this.callbacks.persistTopicSessions()
  }

  /** Handle /retry command */
  async handleRetryCommand(topicSession: TopicSession, nodeId?: string): Promise<void> {
    if (!topicSession.dagId) {
      await this.telegram.sendMessage("⚠️ /retry only works in DAG parent threads.", topicSession.threadId)
      return
    }

    const graph = this.dags.get(topicSession.dagId)
    if (!graph) return

    const failedNodes = nodeId
      ? graph.nodes.filter((n) => n.id === nodeId && n.status === "failed")
      : graph.nodes.filter((n) => n.status === "failed")

    if (failedNodes.length === 0) {
      await this.telegram.sendMessage("No failed nodes to retry.", topicSession.threadId)
      return
    }

    for (const node of failedNodes) {
      resetFailedNode(graph, node.id)

      const childSession = this.findChildSessionByDagNode(graph.id, node.id)

      if (childSession) {
        const retryTask = [
          `## Retry task`,
          `Previous attempt failed: ${node.error ?? "unknown reason"}`,
          `\nOriginal task: "${node.title}"`,
          node.description ? `\nDescription: ${node.description}` : "",
          `\nCheck the workspace, fix any issues, and create a PR.`,
        ].join("\n")

        childSession.conversation = [{ role: "user", text: retryTask }]
        node.status = "running"
        await this.callbacks.spawnTopicAgent(childSession, retryTask, undefined, DEFAULT_RECOVERY_PROMPT)
      } else {
        await this.scheduleDagNodes(topicSession, graph, this.isStack(graph))
      }
    }

    await this.updateDagPRDescriptions(graph, topicSession.cwd)
    await this.callbacks.persistTopicSessions()
  }

  /** Handle /land command */
  async handleLandCommand(topicSession: TopicSession): Promise<void> {
    if (!topicSession.dagId && (!topicSession.childThreadIds || topicSession.childThreadIds.length === 0)) {
      await this.telegram.sendMessage(
        `⚠️ No DAG or stack found. Use /stack or /dag first.`,
        topicSession.threadId,
      )
      return
    }

    const graph = topicSession.dagId ? this.dags.get(topicSession.dagId) : undefined

    if (graph) {
      await this.landDag(topicSession, graph)
    } else {
      await this.landChildPRs(topicSession)
    }
  }

  /** Land DAG PRs in topological order */
  private async landDag(topicSession: TopicSession, graph: DagGraph): Promise<void> {
    const sorted = topologicalSort(graph)
    const prNodes = sorted
      .map((id) => graph.nodes.find((n) => n.id === id)!)
      .filter((n) => n.status === "done" && n.prUrl)

    if (prNodes.length === 0) {
      await this.telegram.sendMessage(`⚠️ No completed PRs to land.`, topicSession.threadId)
      return
    }

    let succeeded = 0
    for (const node of prNodes) {
      try {
        execSync(
          `gh pr merge ${JSON.stringify(node.prUrl!)} --squash`,
          { cwd: topicSession.cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, env: { ...process.env } },
        )
        succeeded++
        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        await this.telegram.sendMessage(
          `❌ Failed to land <b>${node.title}</b>: ${err instanceof Error ? err.message : String(err)}`,
          topicSession.threadId,
        )
        break
      }
    }

    await this.telegram.sendMessage(
      `✅ Landed ${succeeded}/${prNodes.length} PRs.`,
      topicSession.threadId,
    )
  }

  /** Land child PRs (for split sessions) */
  private async landChildPRs(topicSession: TopicSession): Promise<void> {
    if (!topicSession.childThreadIds) return

    const prUrls: { title: string; prUrl: string }[] = []
    for (const childId of topicSession.childThreadIds) {
      const child = this.callbacks.getTopicSession(childId)
      if (child) {
        const prUrl = this.callbacks.extractPRFromConversation(child)
        if (prUrl) {
          prUrls.push({ title: child.splitLabel ?? child.slug, prUrl })
        }
      }
    }

    if (prUrls.length === 0) {
      await this.telegram.sendMessage(`⚠️ No PRs found.`, topicSession.threadId)
      return
    }

    const anyCwd = topicSession.cwd || this.callbacks.getTopicSession(topicSession.childThreadIds[0])?.cwd
    let succeeded = 0

    for (const { title, prUrl } of prUrls) {
      try {
        execSync(
          `gh pr merge ${JSON.stringify(prUrl)} --squash`,
          { cwd: anyCwd, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, env: { ...process.env } },
        )
        succeeded++
        await new Promise((resolve) => setTimeout(resolve, 3000))
      } catch (err) {
        await this.telegram.sendMessage(
          `❌ Failed to land <b>${title}</b>: ${err instanceof Error ? err.message : String(err)}`,
          topicSession.threadId,
        )
        break
      }
    }

    await this.telegram.sendMessage(
      `✅ Landed ${succeeded}/${prUrls.length} PRs.`,
      topicSession.threadId,
    )
  }

  /** Find child session by DAG node */
  private findChildSessionByDagNode(dagId: string, nodeId: string): TopicSession | undefined {
    for (const [, session] of this.callbacks.getAllTopicSessions()) {
      if (session.dagId === dagId && session.dagNodeId === nodeId) {
        return session
      }
    }
    return undefined
  }

  /** Notify parent of child completion (handles both DAG and split) */
  async notifyParentOfChildComplete(childSession: TopicSession, state: string): Promise<void> {
    if (childSession.dagId && childSession.dagNodeId) {
      await this.onDagChildComplete(childSession, state)
      return
    }

    // Handle non-DAG split child
    if (!childSession.parentThreadId) return

    const parent = this.callbacks.getTopicSession(childSession.parentThreadId)
    if (!parent) return

    const label = childSession.splitLabel ?? childSession.slug
    const prUrl = this.callbacks.extractPRFromConversation(childSession) ?? undefined
    if (prUrl) childSession.prUrl = prUrl

    childSession.conversation = []

    await this.callbacks.updatePinnedSplitStatus(parent)

    if (!parent.childThreadIds) return

    const allDone = parent.childThreadIds.every((id) => {
      const child = this.callbacks.getTopicSession(id)
      return !child || !child.activeSessionId
    })

    if (allDone) {
      let succeeded = 0
      for (const id of parent.childThreadIds) {
        const child = this.callbacks.getTopicSession(id)
        if (child?.prUrl) succeeded++
      }
      await this.callbacks.updateTopicTitle(
        parent,
        succeeded === parent.childThreadIds.length ? "✅" : "⚠️",
      )
      await this.callbacks.runDeferredBabysit(parent.threadId)
    }
  }
}

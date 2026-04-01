import crypto from "node:crypto"
import type { DispatcherContext } from "./dispatcher-context.js"
import type {
  TopicSession, SessionMeta, SessionMode,
  TelegramPhotoSize, AutoAdvance,
} from "../types.js"
import type { McpConfig } from "../config/config-types.js"
import { SessionHandle, type SessionConfig } from "../session/session.js"
import { generateSlug, taskToLabel } from "../slugs.js"
import { extractRepoName, appendImageContext } from "../commands/command-parser.js"
import { DEFAULT_PROMPTS, DEFAULT_CI_FIX_PROMPT } from "../config/prompts.js"
import {
  formatThinkComplete,
  formatReviewComplete,
  formatPlanComplete,
  formatTaskComplete,
  formatQualityReport,
  formatQualityReportForContext,
  formatBudgetWarning,
  formatPinnedStatus,
} from "../telegram/format.js"
import { runQualityGates } from "../ci/quality-gates.js"
import { writeSessionLog } from "../session/session-log.js"
import { captureException } from "../sentry.js"
import { loggers } from "../logger.js"

const log = loggers.dispatcher

/**
 * SessionLifecycle — extracted from Dispatcher.
 *
 * Owns session creation, agent spawning, and completion handling:
 * - startTopicSession: create topic + workspace + spawn agent
 * - spawnTopicAgent: instantiate SessionHandle with event/completion callbacks
 * - handleSessionComplete: cleanup, quality gates, CI babysitting, state persistence
 * - spawnCIFixAgent: spawn a CI-fix agent with a completion callback
 */
export class SessionLifecycle {
  private readonly ctx: DispatcherContext

  constructor(ctx: DispatcherContext) {
    this.ctx = ctx
  }

  async startTopicSession(
    repoUrl: string | undefined,
    task: string,
    mode: SessionMode,
    photos?: TelegramPhotoSize[],
    profileId?: string,
    autoAdvance?: AutoAdvance,
  ): Promise<void> {
    const sessionId = crypto.randomUUID()
    const slug = generateSlug(sessionId)
    const repo = repoUrl ? extractRepoName(repoUrl) : "local"
    const label = taskToLabel(task)
    const topicHandle = `${slug}/${label}`
    const emoji = autoAdvance
      ? "🚢"
      : mode === "think"
      ? "🧠"
      : mode === "plan"
      ? "📋"
      : mode === "review"
      ? "👀"
      : ""
    const topicName = emoji ? `${emoji} ${topicHandle}` : topicHandle

    let topic: { message_thread_id: number }
    try {
      topic = await this.ctx.telegram.createForumTopic(topicName)
    } catch (err) {
      log.error({ err, topicName }, "failed to create topic")
      captureException(err, { operation: "createForumTopic" })
      return
    }

    const threadId = topic.message_thread_id

    const cwd = await this.ctx.prepareWorkspace(slug, repoUrl)
    if (!cwd) {
      await this.ctx.telegram.sendMessage(`❌ Failed to prepare workspace.`, threadId)
      await this.ctx.telegram.deleteForumTopic(threadId)
      return
    }

    const imagePaths = await this.ctx.downloadPhotos(photos, cwd)
    const fullTask = appendImageContext(task, imagePaths)

    const topicSession: TopicSession = {
      threadId,
      repo,
      repoUrl,
      cwd,
      slug,
      topicHandle,
      conversation: [{ role: "user", text: fullTask, images: imagePaths.length > 0 ? imagePaths : undefined }],
      pendingFeedback: [],
      mode,
      lastActivityAt: Date.now(),
      profileId,
      branch: repoUrl ? `minion/${slug}` : undefined,
      autoAdvance,
    }

    this.ctx.topicSessions.set(threadId, topicSession)
    this.ctx.broadcastSession(topicSession, "session_created")
    this.ctx.updatePinnedSummary()

    await this.spawnTopicAgent(topicSession, fullTask)
  }

  async spawnTopicAgent(topicSession: TopicSession, task: string, mcpOverrides?: Partial<McpConfig>, systemPromptOverride?: string): Promise<void> {
    await this.ctx.refreshGitToken()
    if (this.ctx.sessions.size >= this.ctx.config.workspace.maxConcurrentSessions) {
      await this.ctx.telegram.sendMessage(
        `⚠️ Max concurrent sessions reached. Try again later.`,
        topicSession.threadId,
      )
      return
    }

    const sessionId = crypto.randomUUID()
    topicSession.activeSessionId = sessionId
    this.ctx.broadcastSession(topicSession, "session_updated")

    const meta: SessionMeta = {
      sessionId,
      threadId: topicSession.threadId,
      topicName: topicSession.topicHandle ?? topicSession.slug,
      repo: topicSession.repo,
      cwd: topicSession.cwd,
      startedAt: Date.now(),
      mode: topicSession.mode,
    }

    const onTextCapture = (_sid: string, text: string) => {
      this.ctx.pushToConversation(topicSession, { role: "assistant", text })
    }

    const prompts = { ...DEFAULT_PROMPTS, ...this.ctx.config.prompts }
    const profile = topicSession.profileId ? this.ctx.profileStore.get(topicSession.profileId) : undefined
    const sessionConfig: SessionConfig = {
      goose: this.ctx.config.goose,
      claude: this.ctx.config.claude,
      mcp: mcpOverrides ? { ...this.ctx.config.mcp, ...mcpOverrides } : this.ctx.config.mcp,
      profile,
      sessionEnvPassthrough: this.ctx.config.sessionEnvPassthrough,
      agentDefs: this.ctx.config.agentDefs,
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.ctx.observer.onEvent(meta, event).catch((err) => {
          loggers.observer.error({ err, sessionId }, "onEvent error")
        })

        if (event.type === "complete" && meta.totalTokens != null && meta.totalTokens > this.ctx.config.workspace.sessionTokenBudget) {
          log.warn({ sessionId, totalTokens: meta.totalTokens, budget: this.ctx.config.workspace.sessionTokenBudget }, "session exceeded token budget")
          this.ctx.telegram.sendMessage(
            formatBudgetWarning(topicSession.slug, meta.totalTokens, this.ctx.config.workspace.sessionTokenBudget),
            topicSession.threadId,
          ).catch(() => {})
          handle.interrupt()
        }
      },
      (m, state) => this.handleSessionComplete(topicSession, m, state, sessionId),
      this.ctx.config.workspace.sessionTimeoutMs,
      this.ctx.config.workspace.sessionInactivityTimeoutMs,
      sessionConfig,
    )

    this.ctx.sessions.set(topicSession.threadId, { handle, meta, task })

    await this.ctx.updateTopicTitle(topicSession, "⚡")
    this.ctx.updatePinnedSummary()
    const onDeadThread = () => {
      log.warn({ threadId: meta.threadId, slug: topicSession.slug }, "thread not found, removing session from store")
      this.ctx.topicSessions.delete(meta.threadId)
      this.ctx.persistTopicSessions().catch(() => {})
    }
    await this.ctx.observer.onSessionStart(meta, task, onTextCapture, onDeadThread)
    const systemPrompt = systemPromptOverride ?? (topicSession.mode === "task" ? prompts.task : undefined)
    handle.start(task, systemPrompt)
  }

  handleSessionComplete(topicSession: TopicSession, m: SessionMeta, state: "completed" | "errored", sessionId: string): void {
    if (topicSession.activeSessionId !== m.sessionId) return

    const durationMs = Date.now() - m.startedAt
    this.ctx.sessions.delete(topicSession.threadId)
    topicSession.activeSessionId = undefined
    topicSession.lastActivityAt = Date.now()
    this.ctx.broadcastSession(topicSession, "session_updated", state as "completed" | "errored")
    this.ctx.updatePinnedSummary()

    this.ctx.stats.record({
      slug: topicSession.slug,
      repo: topicSession.repo,
      mode: topicSession.mode,
      state,
      durationMs,
      totalTokens: m.totalTokens ?? 0,
      timestamp: Date.now(),
    }).catch(() => {})

    // Ship auto-advance
    if (topicSession.autoAdvance && (topicSession.mode === "ship-think" || topicSession.mode === "ship-plan" || topicSession.mode === "ship-verify")) {
      if (state === "completed") {
        this.ctx.observer.flushAndComplete(m, state, durationMs).then(() => {
          writeSessionLog(topicSession, m, state, durationMs)
          this.ctx.handleShipAdvance(topicSession).catch((err) => {
            loggers.ship.error({ err, slug: topicSession.slug }, "ship advance error")
            this.ctx.telegram.sendMessage(
              `❌ Ship pipeline error during ${topicSession.autoAdvance!.phase} phase: ${err instanceof Error ? err.message : String(err)}`,
              topicSession.threadId,
            ).catch(() => {})
          })
        }).catch((err) => {
          loggers.ship.error({ err }, "flushAndComplete error in ship phase")
        })
      } else {
        // Keep phase unchanged so the user can retry — don't set to "done"
        this.ctx.updateTopicTitle(topicSession, "⚠️").catch(() => {})
        this.ctx.observer.onSessionComplete(m, state, durationMs).catch(() => {})
        const phase = topicSession.autoAdvance.phase
        this.ctx.telegram.sendMessage(
          `⚠️ Ship pipeline paused: ${topicSession.mode} phase errored during <b>${phase}</b>.\n\nRecovery options:\n• /retry — re-run the current phase\n• /dag — retry DAG extraction\n• /execute — run as a single task\n• /split — split into parallel sub-tasks\n• /close — abandon this ship`,
          topicSession.threadId,
        ).catch(() => {})
        writeSessionLog(topicSession, m, state, durationMs)
      }
      this.ctx.persistTopicSessions().catch(() => {})
      this.ctx.cleanBuildArtifacts(topicSession.cwd)
      return
    }

    if (topicSession.mode === "think") {
      this.ctx.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.ctx.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.ctx.telegram.sendMessage(
        formatThinkComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (topicSession.mode === "review") {
      this.ctx.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.ctx.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.ctx.telegram.sendMessage(
        formatReviewComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (topicSession.mode === "plan") {
      this.ctx.updateTopicTitle(topicSession, "💬").catch(() => {})
      this.ctx.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      this.ctx.telegram.sendMessage(
        formatPlanComplete(topicSession.slug),
        topicSession.threadId,
      ).catch(() => {})
      writeSessionLog(topicSession, m, state, durationMs)
    } else if (state === "errored") {
      topicSession.lastState = "errored"
      this.ctx.updateTopicTitle(topicSession, "❌").catch(() => {})
      this.ctx.observer.onSessionComplete(m, state, durationMs).catch((err) => {
        loggers.observer.error({ err, sessionId }, "onSessionComplete error")
      })
      writeSessionLog(topicSession, m, state, durationMs)
    } else {
      topicSession.lastState = "completed"
      this.ctx.updateTopicTitle(topicSession, "✅").catch(() => {})
      this.ctx.observer.flushAndComplete(m, state, durationMs).then(async () => {
        await this.ctx.telegram.sendMessage(
          formatTaskComplete(topicSession.slug, durationMs, m.totalTokens),
          topicSession.threadId,
        )

        let qualityReport
        try {
          qualityReport = runQualityGates(topicSession.cwd)
          if (qualityReport.results.length > 0) {
            await this.ctx.telegram.sendMessage(
              formatQualityReport(qualityReport.results),
              topicSession.threadId,
            )
          }
          if (qualityReport && !qualityReport.allPassed) {
            this.ctx.pushToConversation(topicSession, {
              role: "user",
              text: formatQualityReportForContext(qualityReport.results),
            })
          }
        } catch (err) {
          log.error({ err, sessionId }, "quality gates error")
          captureException(err, { operation: "qualityGates" })
        }

        writeSessionLog(topicSession, m, state, durationMs, qualityReport)

        if (topicSession.mode === "task") {
          const prUrl = this.ctx.extractPRFromConversation(topicSession)
          if (prUrl) {
            topicSession.prUrl = prUrl
            this.ctx.postSessionDigest(topicSession, prUrl)
            await this.ctx.pinThreadMessage(
              topicSession,
              formatPinnedStatus(topicSession.slug, topicSession.repo, "completed", prUrl),
            )
            if (this.ctx.config.ci.babysitEnabled) {
              if (topicSession.dagId) {
                // DAG children: CI is handled inline in onDagChildComplete
              } else if (topicSession.parentThreadId) {
                this.ctx.queueDeferredBabysit(topicSession.parentThreadId, { childSession: topicSession, prUrl, qualityReport })
              } else {
                this.ctx.babysitPR(topicSession, prUrl, qualityReport).catch((err) => {
                  log.error({ err, prUrl }, "babysitPR error")
                  captureException(err, { operation: "babysitPR", prUrl })
                })
              }
            }
          } else {
            await this.ctx.pinThreadMessage(
              topicSession,
              formatPinnedStatus(topicSession.slug, topicSession.repo, "completed"),
            )
          }
        }
      }).catch((err) => {
        loggers.observer.error({ err, sessionId }, "flushAndComplete error")
      })
    }

    this.ctx.persistTopicSessions().catch(() => {})
    this.ctx.cleanBuildArtifacts(topicSession.cwd)

    this.ctx.notifyParentOfChildComplete(topicSession, state).catch((err) => {
      log.warn({ err, slug: topicSession.slug }, "parent notify error")
    })

    if (topicSession.pendingFeedback.length > 0) {
      const feedback = topicSession.pendingFeedback.join("\n\n")
      topicSession.pendingFeedback = []
      this.ctx.handleTopicFeedback(topicSession, feedback).catch((err) => {
        log.error({ err }, "queued feedback error")
      })
    }
  }

  async spawnCIFixAgent(
    topicSession: TopicSession,
    task: string,
    onComplete: () => void,
  ): Promise<void> {
    if (this.ctx.sessions.size >= this.ctx.config.workspace.maxConcurrentSessions) {
      log.warn("no session slots for CI fix, skipping")
      onComplete()
      return
    }

    const sessionId = crypto.randomUUID()
    topicSession.activeSessionId = sessionId

    const meta: SessionMeta = {
      sessionId,
      threadId: topicSession.threadId,
      topicName: topicSession.topicHandle ?? topicSession.slug,
      repo: topicSession.repo,
      cwd: topicSession.cwd,
      startedAt: Date.now(),
      mode: "ci-fix",
    }

    const sessionConfig: SessionConfig = {
      goose: this.ctx.config.goose,
      claude: this.ctx.config.claude,
      mcp: this.ctx.config.mcp,
      sessionEnvPassthrough: this.ctx.config.sessionEnvPassthrough,
      agentDefs: this.ctx.config.agentDefs,
    }

    const handle = new SessionHandle(
      meta,
      (event) => {
        this.ctx.observer.onEvent(meta, event).catch((err) => {
          log.error({ err }, "CI fix onEvent error")
        })
      },
      (m, state) => {
        if (topicSession.activeSessionId !== m.sessionId) return

        const durationMs = Date.now() - m.startedAt
        this.ctx.sessions.delete(topicSession.threadId)
        topicSession.activeSessionId = undefined
        topicSession.lastActivityAt = Date.now()

        this.ctx.stats.record({
          slug: topicSession.slug,
          repo: topicSession.repo,
          mode: "ci-fix",
          state,
          durationMs,
          totalTokens: m.totalTokens ?? 0,
          timestamp: Date.now(),
        }).catch(() => {})

        this.ctx.observer.flushAndComplete(m, state, durationMs).then(() => {
          writeSessionLog(topicSession, m, state, durationMs)
          onComplete()
        }).catch(() => {
          onComplete()
        })
      },
      this.ctx.config.workspace.sessionTimeoutMs,
      this.ctx.config.workspace.sessionInactivityTimeoutMs,
      sessionConfig,
    )

    this.ctx.sessions.set(topicSession.threadId, { handle, meta, task })

    const onDeadThread = () => {
      log.warn({ threadId: meta.threadId, slug: topicSession.slug }, "thread not found, removing session from store")
      this.ctx.topicSessions.delete(meta.threadId)
      this.ctx.persistTopicSessions().catch(() => {})
    }
    await this.ctx.observer.onSessionStart(meta, task, undefined, onDeadThread)
    handle.start(task, DEFAULT_CI_FIX_PROMPT)
  }
}

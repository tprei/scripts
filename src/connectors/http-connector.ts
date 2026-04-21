import http from "node:http"
import type { Connector } from "./connector.js"
import type { MinionEngine } from "../engine/engine.js"
import {
  createApiServer,
  StateBroadcaster,
  topicSessionToApi,
  dagToApi,
  type DispatcherApi,
} from "../api-server.js"
import { PushSubscriptionStore } from "../push/push-subscriptions.js"
import { loadOrCreateVapidKeys, type VapidKeys } from "../push/vapid-keys.js"
import { PushNotifier } from "../push/push-notifier.js"
import { ResourceCollector } from "../metrics/resource-collector.js"
import type { ResourceSnapshot } from "../metrics/types.js"
import {
  RuntimeOverridesStore,
  buildSchema,
  type LoopMeta,
} from "../config/runtime-overrides.js"

export interface HttpConnectorOptions {
  port: number
  uiDistPath: string
  /** Telegram chat id — embedded into t.me links in ApiSession payloads
   *  when a TelegramConnector is also registered. Leave undefined for
   *  PWA-only deployments. */
  chatId?: string
  /** Telegram bot token — enables the /validate endpoint used by the
   *  Telegram WebApp login flow. Leave undefined for PWA-only deployments. */
  botToken?: string
  apiToken?: string
  corsAllowedOrigins?: string[]
  repos?: Record<string, string>
  /** Workspace root. Required to enable Web Push (VAPID keys + subscription
   *  store are persisted under `${workspaceRoot}/.push/`). */
  workspaceRoot?: string
}

/**
 * HttpConnector — serves the REST/SSE API and PWA assets.
 *
 * On attach, subscribes to MinionEngine event bus and translates engine
 * events into `SseEvent`s that the PWA consumes. Replaces the earlier
 * pattern where MinionEngine pushed SSE frames directly through a
 * StateBroadcaster handed in at construction time.
 *
 * When `workspaceRoot` is supplied, also initializes Web Push:
 *   - loads (or generates on first boot) VAPID keys from
 *     `${workspaceRoot}/.push/vapid.json`
 *   - loads the subscription store from
 *     `${workspaceRoot}/.push/subscriptions.json`
 *   - attaches a PushNotifier that fans `session_needs_attention` events
 *     out to subscribed PWA clients
 *
 * The connector owns the broadcaster + http.Server. `start()` binds the
 * port (done separately from attach() so orchestration can control when
 * the port opens relative to engine warm-up).
 */
export class HttpConnector implements Connector {
  readonly name = "http"
  readonly broadcaster: StateBroadcaster
  private server: http.Server | null = null
  private subscriptions: Array<() => void> = []
  private pushSubscriptions: PushSubscriptionStore | null = null
  private vapidKeys: VapidKeys | null = null
  private pushNotifier: PushNotifier | null = null
  private attachPromise: Promise<void> = Promise.resolve()
  private resourceCollector: ResourceCollector | null = null
  private runtimeOverrides: RuntimeOverridesStore | null = null
  private engineRef: MinionEngine | null = null

  constructor(private readonly opts: HttpConnectorOptions) {
    this.broadcaster = new StateBroadcaster()
  }

  attach(engine: MinionEngine): Promise<void> {
    this.attachPromise = this.doAttach(engine)
    return this.attachPromise
  }

  private async doAttach(engine: MinionEngine): Promise<void> {
    this.engineRef = engine
    const chatId = this.opts.chatId
    const topicSessions = engine.getTopicSessions()
    const activeSessions = engine.getSessions()

    this.subscriptions.push(
      engine.events.on("session_created", (e) => {
        const api = topicSessionToApi(e.session, chatId, e.session.activeSessionId)
        this.broadcaster.broadcast({ type: "session_created", session: api })
      }),
      engine.events.on("session_updated", (e) => {
        const api = topicSessionToApi(e.session, chatId, e.session.activeSessionId, e.sessionState)
        this.broadcaster.broadcast({ type: "session_updated", session: api })
      }),
      engine.events.on("session_deleted", (e) => {
        this.broadcaster.broadcast({ type: "session_deleted", sessionId: e.sessionId })
      }),
      engine.events.on("dag_created", (e) => {
        const api = dagToApi(e.dag, topicSessions, activeSessions, chatId)
        this.broadcaster.broadcast({ type: "dag_created", dag: api })
      }),
      engine.events.on("dag_updated", (e) => {
        const api = dagToApi(e.dag, topicSessions, activeSessions, chatId)
        this.broadcaster.broadcast({ type: "dag_updated", dag: api })
      }),
      engine.events.on("dag_deleted", (e) => {
        this.broadcaster.broadcast({ type: "dag_deleted", dagId: e.dagId })
      }),
      engine.events.on("transcript_event", (e) => {
        this.broadcaster.broadcast({ type: "transcript_event", sessionId: e.sessionId, event: e.event })
      }),
    )

    // Web Push initialization — skipped when no workspace is provided.
    if (this.opts.workspaceRoot) {
      this.vapidKeys = await loadOrCreateVapidKeys(this.opts.workspaceRoot)
      this.pushSubscriptions = new PushSubscriptionStore(this.opts.workspaceRoot)
      await this.pushSubscriptions.load()
      this.pushNotifier = new PushNotifier(engine.events, this.pushSubscriptions, this.vapidKeys)
      this.pushNotifier.attach()

      this.runtimeOverrides = new RuntimeOverridesStore(this.opts.workspaceRoot)
      await this.runtimeOverrides.load()
      engine.setRuntimeOverridesStore(this.runtimeOverrides)

      const resourceCollector = new ResourceCollector({
        workspaceRoot: this.opts.workspaceRoot,
        callbacks: {
          getActiveSessionCount: () => engine.getSessions().size,
          getMaxSessionCount: () => engine.getConfig().workspace.maxConcurrentSessions,
          getActiveLoopCount: () => engine.getLoopScheduler()?.getActiveLoopCount() ?? 0,
          getMaxLoopCount: () => engine.getConfig().loops?.maxConcurrentLoops ?? 0,
        },
        onSnapshot: (snapshot: ResourceSnapshot) => {
          this.broadcaster.broadcast({ type: "resource", snapshot })
        },
      })
      this.resourceCollector = resourceCollector
      resourceCollector.start()
    }

    const dispatcherApi: DispatcherApi = {
      getSessions: () => engine.getSessions(),
      getTopicSessions: () => engine.getTopicSessions(),
      getDags: () => engine.getDags(),
      getSessionState: (threadId) => engine.getSessionState(threadId),
      sendReply: (threadId, message) => engine.apiSendReply(threadId, message),
      stopSession: (threadId) => engine.apiStopSession(threadId),
      closeSession: (threadId) => engine.apiCloseSession(threadId),
      handleIncomingText: (text, sessionSlug) => engine.handleIncomingText(text, sessionSlug),
      createSession: (request) => engine.createSession(request),
      createSessionVariants: (request, count) => engine.createSessionVariants(request, count),
      getTranscript: (slug, afterSeq) => {
        const topicSession = [...engine.getTopicSessions().values()].find((s) => s.slug === slug)
        if (!topicSession) return undefined
        const events = engine.transcriptStore.getSince(slug, afterSeq)
        const storeHwm = engine.transcriptStore.highWaterMark(slug)
        return {
          session: {
            sessionId: slug,
            topicName: slug,
            repo: topicSession.repo,
            mode: topicSession.mode,
            startedAt: topicSession.lastActivityAt,
            transcriptUrl: `/api/sessions/${encodeURIComponent(slug)}/transcript`,
          },
          events,
          highWaterMark: storeHwm,
        }
      },
      getResourceSnapshot: () => this.resourceCollector?.getLatest() ?? null,
      getRuntimeOverridesStore: () => this.runtimeOverrides,
      getRuntimeOverridesSchema: () => buildSchema(collectLoopMetas(engine)),
      getBaseConfig: () => buildBaseConfigView(engine),
    }

    this.server = createApiServer(dispatcherApi, {
      port: this.opts.port,
      uiDistPath: this.opts.uiDistPath,
      chatId: this.opts.chatId,
      botToken: this.opts.botToken,
      broadcaster: this.broadcaster,
      apiToken: this.opts.apiToken,
      corsAllowedOrigins: this.opts.corsAllowedOrigins,
      repos: this.opts.repos,
      pushSubscriptions: this.pushSubscriptions ?? undefined,
      vapidKeys: this.vapidKeys ?? undefined,
    })
  }

  /** Bind the HTTP server to its port. Awaits attach() internally so it is
   *  safe to call right after `engine.use(connector)` without a manual await. */
  async start(): Promise<void> {
    await this.attachPromise
    if (!this.server) throw new Error("HttpConnector.start() called before attach()")
    const server = this.server
    const port = this.opts.port
    await new Promise<void>((resolve) => {
      server.listen(port, () => resolve())
    })
  }

  detach(): void {
    for (const unsub of this.subscriptions) unsub()
    this.subscriptions = []
    this.pushNotifier?.detach()
    this.pushNotifier = null
    this.resourceCollector?.stop()
    this.resourceCollector = null
    this.engineRef = null
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  getServer(): http.Server | null {
    return this.server
  }
}

function collectLoopMetas(engine: MinionEngine): LoopMeta[] {
  const scheduler = engine.getLoopScheduler()
  if (!scheduler) return []
  const metas: LoopMeta[] = []
  for (const def of scheduler.getDefinitions().values()) {
    metas.push({
      id: def.id,
      name: def.name,
      defaultIntervalMs: def.intervalMs,
      defaultEnabled: def.enabled,
    })
  }
  return metas
}

function buildBaseConfigView(engine: MinionEngine): Record<string, unknown> {
  const config = engine.getConfig()
  const scheduler = engine.getLoopScheduler()
  const loops: Record<string, { enabled: boolean; intervalMs: number }> = {}
  if (scheduler) {
    for (const def of scheduler.getDefinitions().values()) {
      const state = scheduler.getStates().get(def.id)
      loops[def.id] = {
        enabled: def.enabled && (state?.enabled ?? false),
        intervalMs: def.intervalMs,
      }
    }
  }
  return {
    workspace: { maxConcurrentSessions: config.workspace.maxConcurrentSessions },
    loopsConfig: {
      maxConcurrentLoops: config.loops?.maxConcurrentLoops ?? 0,
      reservedInteractiveSlots: config.loops?.reservedInteractiveSlots ?? 0,
    },
    quota: {
      retryMax: config.quota.retryMax,
      defaultSleepMs: config.quota.defaultSleepMs,
    },
    ci: { babysitEnabled: config.ci.babysitEnabled },
    mcp: { ...config.mcp },
    loops,
  }
}

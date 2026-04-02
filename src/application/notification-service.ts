import type { TopicSession, SessionDoneState } from "../types.js"
import type { DagGraph } from "../dag/dag.js"
import type { StateBroadcaster } from "../api-server.js"
import { topicSessionToApi, dagToApi } from "../api-server.js"
import type { PinnedMessageManager } from "../telegram/pinned-message-manager.js"
import type { ActiveSession } from "../session/session-manager.js"

export interface NotificationDeps {
  readonly chatId: string
  readonly topicSessions: Map<number, TopicSession>
  readonly sessions: Map<number, ActiveSession>
  readonly pinnedMessages: PinnedMessageManager
  readonly broadcaster?: StateBroadcaster
}

export interface NotificationService {
  broadcastSession(session: TopicSession, eventType: "session_created" | "session_updated", sessionState?: SessionDoneState): void
  broadcastSessionDeleted(slug: string): void
  broadcastDag(graph: DagGraph, eventType: "dag_created" | "dag_updated"): void
  broadcastDagDeleted(dagId: string): void
  updatePinnedSummary(): void
  updateTopicTitle(topicSession: TopicSession, stateEmoji: string): Promise<void>
  pinThreadMessage(session: TopicSession, html: string): Promise<void>
  updatePinnedSplitStatus(parent: TopicSession): Promise<void>
  updatePinnedDagStatus(parent: TopicSession, graph: DagGraph): Promise<void>
}

export function createNotificationService(deps: NotificationDeps): NotificationService {
  return {
    broadcastSession(session, eventType, sessionState) {
      if (!deps.broadcaster) return
      const apiSession = topicSessionToApi(session, deps.chatId, session.activeSessionId, sessionState)
      deps.broadcaster.broadcast({ type: eventType, session: apiSession })
    },

    broadcastSessionDeleted(slug) {
      if (!deps.broadcaster) return
      deps.broadcaster.broadcast({ type: "session_deleted", sessionId: slug })
    },

    broadcastDag(graph, eventType) {
      if (!deps.broadcaster) return
      const apiDag = dagToApi(graph, deps.topicSessions, deps.sessions, deps.chatId)
      deps.broadcaster.broadcast({ type: eventType, dag: apiDag })
    },

    broadcastDagDeleted(dagId) {
      if (!deps.broadcaster) return
      deps.broadcaster.broadcast({ type: "dag_deleted", dagId })
    },

    updatePinnedSummary() {
      deps.pinnedMessages.updatePinnedSummary()
    },

    updateTopicTitle(topicSession, stateEmoji) {
      return deps.pinnedMessages.updateTopicTitle(topicSession, stateEmoji)
    },

    pinThreadMessage(session, html) {
      return deps.pinnedMessages.pinThreadMessage(session, html)
    },

    updatePinnedSplitStatus(parent) {
      return deps.pinnedMessages.updatePinnedSplitStatus(parent)
    },

    updatePinnedDagStatus(parent, graph) {
      return deps.pinnedMessages.updatePinnedDagStatus(parent, graph)
    },
  }
}

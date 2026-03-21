import type { TelegramClient } from "./telegram.js"
import type { GooseStreamEvent, GooseMessage, GooseToolRequestContent, SessionMeta } from "./types.js"
import {
  formatToolActivity,
  formatSessionStart,
  formatSessionComplete,
  formatSessionError,
  formatAssistantText,
} from "./format.js"

interface ActivityState {
  messageId: number | null
  lastSentAt: number
  toolCount: number
  lastToolName: string
  lastToolArgs: Record<string, unknown>
}

export class Observer {
  private readonly activity = new Map<string, ActivityState>()

  constructor(
    private readonly telegram: TelegramClient,
    private readonly throttleMs: number,
  ) {}

  async onSessionStart(meta: SessionMeta, task: string): Promise<void> {
    await this.telegram.sendMessage(
      formatSessionStart(meta.repo, meta.topicName, task),
      meta.threadId,
    )
  }

  async onEvent(meta: SessionMeta, event: GooseStreamEvent): Promise<void> {
    switch (event.type) {
      case "message":
        await this.handleMessage(meta, event.message)
        break

      case "error":
        await this.telegram.sendMessage(
          formatSessionError(meta.topicName, event.error),
          meta.threadId,
        )
        break

      case "complete":
      case "notification":
        break
    }
  }

  private async handleMessage(
    meta: SessionMeta,
    message: GooseMessage,
  ): Promise<void> {
    for (const block of message.content) {
      if (block.type === "text" && message.role === "assistant") {
        const text = (block as { type: "text"; text: string }).text.trim()
        if (text) {
          await this.telegram.sendMessage(
            formatAssistantText(meta.topicName, text),
            meta.threadId,
          )
        }
      } else if (block.type === "toolRequest" && message.role === "assistant") {
        await this.handleToolRequest(meta, block as GooseToolRequestContent)
      }
    }
  }

  private async handleToolRequest(
    meta: SessionMeta,
    block: GooseToolRequestContent,
  ): Promise<void> {
    if ("error" in block.toolCall) return

    const { name, arguments: args } = block.toolCall
    const now = Date.now()
    const state = this.activity.get(meta.sessionId)

    if (!state) {
      const html = formatToolActivity(name, args, 1)
      const { messageId } = await this.telegram.sendMessage(html, meta.threadId)
      this.activity.set(meta.sessionId, {
        messageId,
        lastSentAt: now,
        toolCount: 1,
        lastToolName: name,
        lastToolArgs: args,
      })
      return
    }

    state.toolCount++
    state.lastToolName = name
    state.lastToolArgs = args

    if (now - state.lastSentAt < this.throttleMs) {
      return
    }

    const html = formatToolActivity(name, args, state.toolCount)
    state.lastSentAt = now

    if (state.messageId !== null) {
      await this.telegram.editMessage(state.messageId, html, meta.threadId)
    } else {
      const { messageId } = await this.telegram.sendMessage(html, meta.threadId)
      state.messageId = messageId
    }
  }

  async onSessionComplete(
    meta: SessionMeta,
    state: "completed" | "errored",
    durationMs: number,
  ): Promise<void> {
    this.activity.delete(meta.sessionId)

    if (state === "errored") {
      await this.telegram.sendMessage(
        formatSessionError(meta.topicName, "Session ended with an error. Check logs."),
        meta.threadId,
      )
    } else {
      await this.telegram.sendMessage(
        formatSessionComplete(meta.topicName, durationMs, meta.totalTokens),
        meta.threadId,
      )
    }
  }

  clearSession(sessionId: string): void {
    this.activity.delete(sessionId)
  }
}

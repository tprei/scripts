import type { ChatProvider } from "../provider/chat-provider.js"
import type { TopicSession, TopicMessage } from "../domain/session-types.js"
import type { CompletionHandler, SessionCompletionContext } from "./handler-types.js"
import { runQualityGates } from "../ci/quality-gates.js"
import { formatQualityReport, formatQualityReportForContext } from "../telegram/format.js"
import { captureException } from "../sentry.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "quality-gate-handler" })

export interface ConversationPusher {
  pushToConversation(session: TopicSession, message: TopicMessage): void
}

export class QualityGateHandler implements CompletionHandler {
  readonly name = "QualityGateHandler"

  constructor(
    private readonly chat: ChatProvider,
    private readonly conversationPusher: ConversationPusher,
  ) {}

  async handle(ctx: SessionCompletionContext): Promise<void> {
    if (ctx.state !== "completed") return

    const { topicSession, sessionId } = ctx

    try {
      const qualityReport = runQualityGates(topicSession.cwd)
      ctx.qualityReport = qualityReport

      if (qualityReport.results.length > 0) {
        await this.chat.sendMessage(
          formatQualityReport(qualityReport.results),
          topicSession.threadId,
        )
      }
      if (!qualityReport.allPassed) {
        this.conversationPusher.pushToConversation(topicSession, {
          role: "user",
          text: formatQualityReportForContext(qualityReport.results),
        })
      }
    } catch (err) {
      log.error({ err, sessionId }, "quality gates error")
      captureException(err, { operation: "qualityGates" })
    }
  }
}

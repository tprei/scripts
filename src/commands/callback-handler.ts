import type { TelegramCallbackQuery } from "../types.js"
import type { DispatcherContext } from "../orchestration/dispatcher-context.js"
import { buildReviewAllTask, buildProfileKeyboard, escapeHtml } from "./command-parser.js"

export class CallbackQueryHandler {
  constructor(private readonly ctx: DispatcherContext) {}

  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!this.ctx.config.telegram.allowedUserIds.includes(query.from.id)) {
      await this.ctx.telegram.answerCallbackQuery(query.id, "Not authorized")
      return
    }

    const data = query.data
    if (!data) {
      await this.ctx.telegram.answerCallbackQuery(query.id)
      return
    }

    if (data.startsWith("profile:")) {
      await this.handleProfileCallback(query, data.slice("profile:".length))
      return
    }

    if (!data.startsWith("repo:") && !data.startsWith("plan-repo:") && !data.startsWith("think-repo:") && !data.startsWith("review-repo:") && !data.startsWith("ship-repo:")) {
      await this.ctx.telegram.answerCallbackQuery(query.id)
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
    const repoUrl = this.ctx.config.repos[repoSlug]
    if (!repoUrl) {
      await this.ctx.telegram.answerCallbackQuery(query.id, "Unknown repo")
      return
    }

    const messageId = query.message?.message_id

    if (messageId) {
      const pending = this.ctx.pendingTasks.get(messageId)
      if (pending) {
        this.ctx.pendingTasks.delete(messageId)
        await this.ctx.telegram.answerCallbackQuery(query.id, `Selected: ${repoSlug}`)
        await this.ctx.telegram.deleteMessage(messageId)

        pending.repoSlug = repoSlug
        pending.repoUrl = repoUrl
        if (pending.mode === "review" && !pending.task) {
          pending.task = buildReviewAllTask(repoUrl)
        }

        const defaultProfileId = this.ctx.profileStore.getDefaultId()
        if (defaultProfileId) {
          await this.ctx.startTopicSession(repoUrl, pending.task, pending.mode, undefined, defaultProfileId, pending.autoAdvance)
        } else {
          const profiles = this.ctx.profileStore.list()
          if (profiles.length > 1) {
            const label = pending.mode === "ship-think" ? "ship" : pending.mode
            const keyboard = buildProfileKeyboard(profiles)
            const msgId = await this.ctx.telegram.sendMessageWithKeyboard(
              `Pick a profile for ${label}: <i>${escapeHtml(pending.task)}</i>`,
              keyboard,
              pending.threadId,
            )
            if (msgId) {
              this.ctx.pendingProfiles.set(msgId, pending)
            }
          } else {
            await this.ctx.startTopicSession(repoUrl, pending.task, pending.mode, undefined, undefined, pending.autoAdvance)
          }
        }
        return
      }
    }

    await this.ctx.telegram.answerCallbackQuery(query.id)
  }

  private async handleProfileCallback(query: TelegramCallbackQuery, profileId: string): Promise<void> {
    const profile = this.ctx.profileStore.get(profileId)
    if (!profile) {
      await this.ctx.telegram.answerCallbackQuery(query.id, "Unknown profile")
      return
    }

    const messageId = query.message?.message_id
    if (messageId) {
      const pending = this.ctx.pendingProfiles.get(messageId)
      if (pending) {
        this.ctx.pendingProfiles.delete(messageId)
        await this.ctx.telegram.answerCallbackQuery(query.id, `Selected: ${profile.name}`)
        await this.ctx.telegram.deleteMessage(messageId)
        await this.ctx.startTopicSession(pending.repoUrl, pending.task, pending.mode, undefined, profileId, pending.autoAdvance)
        return
      }
    }

    await this.ctx.telegram.answerCallbackQuery(query.id)
  }
}

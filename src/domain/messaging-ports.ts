// ---------------------------------------------------------------------------
// Port interfaces for pluggable messaging providers
//
// These abstractions decouple the orchestration layer from any concrete chat
// platform (Telegram, Slack, Discord, etc.).  A provider supplies three ports:
//
//   MessagingPort  – send / edit / delete messages and media
//   ChannelPort    – manage threads/topics and their lifecycle
//   InputPort      – poll or subscribe to inbound events
// ---------------------------------------------------------------------------

// ============================================================================
// Shared value types
// ============================================================================

/** A button in an inline keyboard row. */
export interface InlineButton {
  text: string
  callbackData: string
}

/** Result of sending a message. */
export interface SendResult {
  ok: boolean
  messageId: string | null
}

/** Describes what the provider supports so callers can degrade gracefully. */
export interface ProviderCapabilities {
  /** Provider can edit previously sent messages in-place. */
  supportsEditing: boolean
  /** Provider supports threaded conversations (forum topics, Slack threads). */
  supportsThreads: boolean
  /** Provider can send inline keyboard buttons. */
  supportsInlineKeyboards: boolean
  /** Provider can pin messages in a channel/thread. */
  supportsPinning: boolean
  /** Provider can send photos/images. */
  supportsPhotos: boolean
}

/** Thread/topic metadata returned after creation. */
export interface ThreadInfo {
  threadId: string
  name: string
}

// ============================================================================
// Inbound event types  (InputPort → core)
// ============================================================================

/** Identity of the user who triggered an inbound event. */
export interface InboundUser {
  id: string
  isBot: boolean
  username?: string
  displayName?: string
}

/** A text or photo message from a user. */
export interface InboundMessage {
  kind: "message"
  /** Provider-specific update/event ID for offset tracking. */
  updateId: string
  messageId: string
  threadId?: string
  from?: InboundUser
  text?: string
  caption?: string
  /** File IDs for any attached photos (largest first). */
  photoFileIds?: string[]
}

/** A callback triggered by an inline keyboard button press. */
export interface InboundCallback {
  kind: "callback"
  updateId: string
  callbackId: string
  from: InboundUser
  /** The message the button was attached to. */
  messageId?: string
  threadId?: string
  data?: string
}

/** Union of all inbound event types. */
export type InboundEvent = InboundMessage | InboundCallback

// ============================================================================
// MessagingPort
// ============================================================================

/**
 * Sending, editing, and deleting messages and media.
 *
 * All `threadId` parameters are optional — when omitted the message targets
 * the default channel / root conversation.
 */
export interface MessagingPort {
  /**
   * Send a text message.
   *
   * The `content` string is provider-native markup (HTML for Telegram,
   * mrkdwn for Slack, etc.).  Format conversion is handled by the adapter,
   * not the caller — callers pass a `MessageContent` from the format layer.
   */
  sendMessage(content: string, threadId?: string, replyToMessageId?: string): Promise<SendResult>

  /**
   * Edit an existing message in-place.
   *
   * Returns `true` if the edit succeeded (or the content was unchanged).
   * Returns `false` if the provider does not support editing or the message
   * was not found.
   */
  editMessage(messageId: string, content: string, threadId?: string): Promise<boolean>

  /** Delete a message by ID. */
  deleteMessage(messageId: string): Promise<void>

  /**
   * Send a message with an inline keyboard.
   *
   * Each inner array is one row of buttons.
   * Returns the message ID on success, `null` on failure.
   */
  sendMessageWithKeyboard(
    content: string,
    keyboard: InlineButton[][],
    threadId?: string,
  ): Promise<string | null>

  /**
   * Acknowledge a callback query (button press).
   *
   * Optionally shows a transient toast/notification to the user.
   */
  answerCallback(callbackId: string, text?: string): Promise<void>

  /**
   * Send a photo from a local file path.
   *
   * Returns the message ID on success, `null` on failure.
   */
  sendPhoto(filePath: string, threadId?: string, caption?: string): Promise<string | null>

  /**
   * Send a photo from an in-memory buffer.
   *
   * Returns the message ID on success, `null` on failure.
   */
  sendPhotoBuffer(
    buffer: Buffer,
    filename: string,
    threadId?: string,
    caption?: string,
  ): Promise<string | null>

  /**
   * Download a provider-hosted file to a local path.
   *
   * `fileId` is provider-specific (e.g. Telegram file_id).
   * Returns `true` on success.
   */
  downloadFile(fileId: string, destPath: string): Promise<boolean>
}

// ============================================================================
// ChannelPort
// ============================================================================

/**
 * Thread/topic lifecycle management and channel-level operations.
 */
export interface ChannelPort {
  /** Create a new thread/topic with the given name. */
  createThread(name: string): Promise<ThreadInfo>

  /** Rename an existing thread/topic. */
  renameThread(threadId: string, name: string): Promise<void>

  /** Close a thread (mark read-only / archive). */
  closeThread(threadId: string): Promise<void>

  /** Permanently delete a thread and its contents. */
  deleteThread(threadId: string): Promise<void>

  /** Pin a message in the channel or thread. */
  pinMessage(messageId: string): Promise<void>

  /** Query provider capabilities so callers can degrade gracefully. */
  capabilities(): ProviderCapabilities
}

// ============================================================================
// InputPort
// ============================================================================

/**
 * Inbound event source — abstracts polling (Telegram) and websocket/webhook
 * (Slack, Discord) patterns behind a single async-iterator interface.
 */
export interface InputPort {
  /**
   * Fetch the next batch of inbound events.
   *
   * For polling providers this maps to long-poll with the given timeout.
   * For push-based providers this resolves when events are available
   * (timeout serves as a max-wait hint).
   *
   * `offset` is an opaque cursor — pass the value from the previous batch
   * to acknowledge processed events.
   */
  getEvents(offset: string, timeoutSeconds: number): Promise<InboundEvent[]>
}

// ============================================================================
// Composite adapter
// ============================================================================

/**
 * A complete provider adapter bundles all three ports.
 *
 * Concrete adapters (TelegramAdapter, SlackAdapter, etc.) implement this
 * interface.  The orchestration layer depends only on `ProviderAdapter`,
 * never on a concrete class.
 */
export interface ProviderAdapter extends MessagingPort, ChannelPort, InputPort {}

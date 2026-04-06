import { describe, it, expect, vi } from "vitest"
import type {
  InlineButton,
  SendResult,
  ProviderCapabilities,
  ThreadInfo,
  InboundUser,
  InboundMessage,
  InboundCallback,
  InboundEvent,
  MessagingPort,
  ChannelPort,
  InputPort,
  ProviderAdapter,
} from "../src/domain/messaging-ports.js"

// Also verify barrel re-exports
import type {
  MessagingPort as BarrelMessagingPort,
  ChannelPort as BarrelChannelPort,
  InputPort as BarrelInputPort,
  ProviderAdapter as BarrelProviderAdapter,
} from "../src/domain/index.js"

describe("domain/messaging-ports value types", () => {
  it("InlineButton has text and callbackData", () => {
    const btn: InlineButton = { text: "Approve", callbackData: "approve:1" }
    expect(btn.text).toBe("Approve")
    expect(btn.callbackData).toBe("approve:1")
  })

  it("SendResult has ok and nullable messageId", () => {
    const success: SendResult = { ok: true, messageId: "42" }
    const failure: SendResult = { ok: false, messageId: null }
    expect(success.ok).toBe(true)
    expect(success.messageId).toBe("42")
    expect(failure.messageId).toBeNull()
  })

  it("ProviderCapabilities describes provider features", () => {
    const caps: ProviderCapabilities = {
      supportsEditing: true,
      supportsThreads: true,
      supportsInlineKeyboards: true,
      supportsPinning: true,
      supportsPhotos: true,
    }
    expect(caps.supportsEditing).toBe(true)

    const limited: ProviderCapabilities = {
      supportsEditing: false,
      supportsThreads: false,
      supportsInlineKeyboards: false,
      supportsPinning: false,
      supportsPhotos: false,
    }
    expect(limited.supportsEditing).toBe(false)
  })

  it("ThreadInfo has string threadId and name", () => {
    const info: ThreadInfo = { threadId: "42", name: "test-topic" }
    expect(info.threadId).toBe("42")
    expect(info.name).toBe("test-topic")
  })
})

describe("domain/messaging-ports inbound events", () => {
  it("InboundUser has string id and isBot flag", () => {
    const user: InboundUser = {
      id: "123",
      isBot: false,
      username: "alice",
      displayName: "Alice",
    }
    expect(user.id).toBe("123")
    expect(user.isBot).toBe(false)
  })

  it("InboundMessage has kind='message' and required fields", () => {
    const msg: InboundMessage = {
      kind: "message",
      updateId: "100",
      messageId: "1",
      threadId: "42",
      from: { id: "1", isBot: false },
      text: "/task fix the bug",
    }
    expect(msg.kind).toBe("message")
    expect(msg.text).toBe("/task fix the bug")
  })

  it("InboundMessage supports photo attachments", () => {
    const msg: InboundMessage = {
      kind: "message",
      updateId: "101",
      messageId: "2",
      caption: "screenshot",
      photoFileIds: ["file-abc", "file-def"],
    }
    expect(msg.photoFileIds).toHaveLength(2)
    expect(msg.caption).toBe("screenshot")
  })

  it("InboundCallback has kind='callback' and callback-specific fields", () => {
    const cb: InboundCallback = {
      kind: "callback",
      updateId: "102",
      callbackId: "cb-1",
      from: { id: "1", isBot: false },
      messageId: "5",
      threadId: "42",
      data: "repo:my-repo",
    }
    expect(cb.kind).toBe("callback")
    expect(cb.callbackId).toBe("cb-1")
    expect(cb.data).toBe("repo:my-repo")
  })

  it("InboundEvent discriminates on kind", () => {
    const events: InboundEvent[] = [
      { kind: "message", updateId: "1", messageId: "1" },
      { kind: "callback", updateId: "2", callbackId: "c1", from: { id: "1", isBot: false } },
    ]
    expect(events).toHaveLength(2)

    for (const event of events) {
      if (event.kind === "message") {
        expect(event.messageId).toBeDefined()
      } else {
        expect(event.callbackId).toBeDefined()
      }
    }
  })
})

describe("MessagingPort interface contract", () => {
  function createMockMessaging(): MessagingPort {
    return {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "1" }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue("2"),
      answerCallback: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue("3"),
      sendPhotoBuffer: vi.fn().mockResolvedValue("4"),
      downloadFile: vi.fn().mockResolvedValue(true),
    }
  }

  it("sendMessage returns SendResult", async () => {
    const port = createMockMessaging()
    const result = await port.sendMessage("<b>hello</b>", "42")
    expect(result.ok).toBe(true)
    expect(result.messageId).toBe("1")
  })

  it("sendMessage accepts optional threadId and replyToMessageId", async () => {
    const port = createMockMessaging()
    await port.sendMessage("text")
    await port.sendMessage("text", "42")
    await port.sendMessage("text", "42", "99")
    expect(port.sendMessage).toHaveBeenCalledTimes(3)
  })

  it("editMessage returns boolean", async () => {
    const port = createMockMessaging()
    const ok = await port.editMessage("1", "updated", "42")
    expect(ok).toBe(true)
  })

  it("deleteMessage returns void", async () => {
    const port = createMockMessaging()
    await port.deleteMessage("1")
    expect(port.deleteMessage).toHaveBeenCalledWith("1")
  })

  it("sendMessageWithKeyboard accepts button grid", async () => {
    const port = createMockMessaging()
    const keyboard: InlineButton[][] = [
      [{ text: "Yes", callbackData: "yes" }, { text: "No", callbackData: "no" }],
    ]
    const msgId = await port.sendMessageWithKeyboard("Pick one:", keyboard, "42")
    expect(msgId).toBe("2")
  })

  it("answerCallback accepts optional text", async () => {
    const port = createMockMessaging()
    await port.answerCallback("cb-1")
    await port.answerCallback("cb-1", "Done!")
    expect(port.answerCallback).toHaveBeenCalledTimes(2)
  })

  it("sendPhoto returns message ID or null", async () => {
    const port = createMockMessaging()
    const id = await port.sendPhoto("/tmp/screenshot.png", "42", "A screenshot")
    expect(id).toBe("3")
  })

  it("sendPhotoBuffer accepts Buffer and filename", async () => {
    const port = createMockMessaging()
    const buf = Buffer.from("fake-png-data")
    const id = await port.sendPhotoBuffer(buf, "shot.png", "42", "caption")
    expect(id).toBe("4")
  })

  it("downloadFile returns boolean", async () => {
    const port = createMockMessaging()
    const ok = await port.downloadFile("file-abc", "/tmp/photo.jpg")
    expect(ok).toBe(true)
  })
})

describe("ChannelPort interface contract", () => {
  function createMockChannel(): ChannelPort {
    return {
      createThread: vi.fn().mockResolvedValue({ threadId: "42", name: "new-topic" }),
      renameThread: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      pinMessage: vi.fn().mockResolvedValue(undefined),
      capabilities: vi.fn().mockReturnValue({
        supportsEditing: true,
        supportsThreads: true,
        supportsInlineKeyboards: true,
        supportsPinning: true,
        supportsPhotos: true,
      }),
    }
  }

  it("createThread returns ThreadInfo", async () => {
    const port = createMockChannel()
    const info = await port.createThread("my-topic")
    expect(info.threadId).toBe("42")
    expect(info.name).toBe("new-topic")
  })

  it("renameThread updates thread name", async () => {
    const port = createMockChannel()
    await port.renameThread("42", "renamed-topic")
    expect(port.renameThread).toHaveBeenCalledWith("42", "renamed-topic")
  })

  it("closeThread archives a thread", async () => {
    const port = createMockChannel()
    await port.closeThread("42")
    expect(port.closeThread).toHaveBeenCalledWith("42")
  })

  it("deleteThread permanently removes a thread", async () => {
    const port = createMockChannel()
    await port.deleteThread("42")
    expect(port.deleteThread).toHaveBeenCalledWith("42")
  })

  it("pinMessage pins by message ID", async () => {
    const port = createMockChannel()
    await port.pinMessage("99")
    expect(port.pinMessage).toHaveBeenCalledWith("99")
  })

  it("capabilities returns feature flags", () => {
    const port = createMockChannel()
    const caps = port.capabilities()
    expect(caps.supportsEditing).toBe(true)
    expect(caps.supportsThreads).toBe(true)
  })
})

describe("InputPort interface contract", () => {
  it("getEvents returns InboundEvent array", async () => {
    const port: InputPort = {
      getEvents: vi.fn().mockResolvedValue([
        { kind: "message", updateId: "1", messageId: "1", text: "hello" },
      ]),
    }
    const events = await port.getEvents("0", 30)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("message")
  })

  it("getEvents returns empty array when no events", async () => {
    const port: InputPort = {
      getEvents: vi.fn().mockResolvedValue([]),
    }
    const events = await port.getEvents("100", 10)
    expect(events).toHaveLength(0)
  })
})

describe("ProviderAdapter composite interface", () => {
  it("combines MessagingPort, ChannelPort, and InputPort", async () => {
    const adapter: ProviderAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "1" }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue("2"),
      answerCallback: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue("3"),
      sendPhotoBuffer: vi.fn().mockResolvedValue("4"),
      downloadFile: vi.fn().mockResolvedValue(true),
      createThread: vi.fn().mockResolvedValue({ threadId: "42", name: "t" }),
      renameThread: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      pinMessage: vi.fn().mockResolvedValue(undefined),
      capabilities: vi.fn().mockReturnValue({
        supportsEditing: true,
        supportsThreads: true,
        supportsInlineKeyboards: true,
        supportsPinning: true,
        supportsPhotos: true,
      }),
      getEvents: vi.fn().mockResolvedValue([]),
    }

    const sendResult = await adapter.sendMessage("hi", "42")
    expect(sendResult.ok).toBe(true)

    const thread = await adapter.createThread("topic")
    expect(thread.threadId).toBe("42")

    const events = await adapter.getEvents("0", 30)
    expect(events).toHaveLength(0)

    expect(adapter.capabilities().supportsEditing).toBe(true)
  })
})

describe("barrel re-exports for messaging ports", () => {
  it("exports MessagingPort via barrel", () => {
    const port: BarrelMessagingPort = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "1" }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue("1"),
      answerCallback: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue("1"),
      sendPhotoBuffer: vi.fn().mockResolvedValue("1"),
      downloadFile: vi.fn().mockResolvedValue(true),
    }
    expect(port.sendMessage).toBeDefined()
  })

  it("exports ChannelPort via barrel", () => {
    const port: BarrelChannelPort = {
      createThread: vi.fn().mockResolvedValue({ threadId: "1", name: "t" }),
      renameThread: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      pinMessage: vi.fn().mockResolvedValue(undefined),
      capabilities: vi.fn().mockReturnValue({
        supportsEditing: false,
        supportsThreads: false,
        supportsInlineKeyboards: false,
        supportsPinning: false,
        supportsPhotos: false,
      }),
    }
    expect(port.capabilities().supportsEditing).toBe(false)
  })

  it("exports InputPort via barrel", () => {
    const port: BarrelInputPort = {
      getEvents: vi.fn().mockResolvedValue([]),
    }
    expect(port.getEvents).toBeDefined()
  })

  it("exports ProviderAdapter via barrel", () => {
    const adapter: BarrelProviderAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: null }),
      editMessage: vi.fn().mockResolvedValue(false),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      sendMessageWithKeyboard: vi.fn().mockResolvedValue(null),
      answerCallback: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(null),
      sendPhotoBuffer: vi.fn().mockResolvedValue(null),
      downloadFile: vi.fn().mockResolvedValue(false),
      createThread: vi.fn().mockResolvedValue({ threadId: "1", name: "t" }),
      renameThread: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      pinMessage: vi.fn().mockResolvedValue(undefined),
      capabilities: vi.fn().mockReturnValue({
        supportsEditing: false,
        supportsThreads: false,
        supportsInlineKeyboards: false,
        supportsPinning: false,
        supportsPhotos: false,
      }),
      getEvents: vi.fn().mockResolvedValue([]),
    }
    expect(adapter).toBeDefined()
  })
})

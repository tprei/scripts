const MAX_LENGTH = 4096

function splitMessage(html: string): string[] {
  if (html.length <= MAX_LENGTH) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > MAX_LENGTH) {
    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf("\n")
    const splitAt = lastNewline > MAX_LENGTH / 2 ? lastNewline : MAX_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

async function sendOne(
  token: string,
  chatId: string,
  html: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<number | null> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text: html, parse_mode: "HTML" }
    if (threadId !== undefined) body.message_thread_id = threadId
    if (replyToMessageId !== undefined) body.reply_to_message_id = replyToMessageId

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const resBody = await res.text()
      process.stderr.write(`telegram: HTTP ${res.status}: ${resBody}\n`)
      return null
    }

    const data = (await res.json()) as { ok: boolean; result: { message_id: number } }
    return data.result.message_id
  } catch (err) {
    process.stderr.write(`telegram: fetch failed: ${err}\n`)
    return null
  }
}

export async function sendMessage(
  token: string,
  chatId: string,
  html: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<{ ok: boolean; messageId: number | null }> {
  const chunks = splitMessage(html)

  const firstId = await sendOne(token, chatId, chunks[0], threadId, replyToMessageId)
  if (firstId === null) return { ok: false, messageId: null }

  for (let i = 1; i < chunks.length; i++) {
    if ((await sendOne(token, chatId, chunks[i], threadId, firstId)) === null)
      return { ok: false, messageId: firstId }
  }

  return { ok: true, messageId: firstId }
}

export async function editMessage(
  token: string,
  chatId: string,
  messageId: number,
  html: string,
  threadId?: number,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
    }
    if (threadId !== undefined) body.message_thread_id = threadId

    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const resBody = await res.text()
      if (resBody.includes("message is not modified")) return true
      process.stderr.write(`telegram: editMessage HTTP ${res.status}: ${resBody}\n`)
      return false
    }

    return true
  } catch (err) {
    process.stderr.write(`telegram: editMessage fetch failed: ${err}\n`)
    return false
  }
}

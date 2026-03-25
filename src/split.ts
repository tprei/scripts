import { execSync } from "node:child_process"
import type { TopicMessage } from "./types.js"

export interface SplitItem {
  title: string
  description: string
}

const SPLIT_EXTRACTION_PROMPT = [
  "You are a task splitter. Given a planning/research conversation, extract discrete, independently implementable work items.",
  "Each item must be self-contained — it should not depend on another item being completed first.",
  "Only include items that can run in parallel without merge conflicts (i.e., they touch different files/modules).",
  "",
  "If the user provided a directive, use it to filter or refine the items.",
  "",
  "Output ONLY a JSON array with no surrounding text or markdown fencing:",
  '[{ "title": "short label (under 60 chars)", "description": "full task description with enough context to implement independently" }]',
  "",
  "If you cannot identify discrete parallelizable items, output an empty array: []",
].join("\n")

export function extractSplitItems(
  conversation: TopicMessage[],
  directive?: string,
): SplitItem[] {
  const MAX_ASSISTANT_CHARS = 4000
  const lines: string[] = ["## Conversation\n"]

  for (const msg of conversation) {
    const label = msg.role === "user" ? "**User**" : "**Agent**"
    lines.push(`${label}:`)
    if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
      lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
    } else {
      lines.push(msg.text)
    }
    lines.push("")
  }

  if (directive) {
    lines.push(`## Directive\n\n${directive}`)
  }

  const task = lines.join("\n")

  try {
    const args = [
      "claude",
      "--print",
      "--output-format", "text",
      "--model", "haiku",
      "--no-session-persistence",
      "--append-system-prompt", SPLIT_EXTRACTION_PROMPT,
    ]
    const output = execSync(
      args.map((a) => JSON.stringify(a)).join(" "),
      {
        input: task,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    ).toString().trim()

    return parseSplitItems(output)
  } catch (err) {
    process.stderr.write(`split: extraction failed: ${err}\n`)
    return []
  }
}

export function parseSplitItems(output: string): SplitItem[] {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.filter(
    (item: unknown): item is SplitItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as SplitItem).title === "string" &&
      typeof (item as SplitItem).description === "string" &&
      (item as SplitItem).title.length > 0 &&
      (item as SplitItem).description.length > 0,
  )
}

export function buildSplitChildPrompt(
  parentConversation: TopicMessage[],
  item: SplitItem,
  allItems: SplitItem[],
): string {
  const MAX_ASSISTANT_CHARS = 4000
  const originalRequest = parentConversation[0]?.text ?? ""

  const lines: string[] = [
    "## Original request",
    "",
    originalRequest,
    "",
  ]

  if (parentConversation.length > 1) {
    lines.push("## Planning thread")
    lines.push("")
    for (const msg of parentConversation.slice(1)) {
      const label = msg.role === "user" ? "**User**" : "**Agent**"
      lines.push(`${label}:`)
      if (msg.role === "assistant" && msg.text.length > MAX_ASSISTANT_CHARS) {
        lines.push(`[earlier output truncated]\n…${msg.text.slice(-MAX_ASSISTANT_CHARS)}`)
      } else {
        lines.push(msg.text)
      }
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(`## Your assigned sub-task: ${item.title}`)
  lines.push("")
  lines.push(item.description)
  lines.push("")
  lines.push("## Scope constraints")
  lines.push("")
  lines.push("The following items from the same planning session are being handled by parallel minions.")
  lines.push("Avoid changes outside your scope to prevent merge conflicts.")
  lines.push("")
  for (const other of allItems) {
    if (other.title !== item.title) {
      lines.push(`- ${other.title}`)
    }
  }

  return lines.join("\n")
}

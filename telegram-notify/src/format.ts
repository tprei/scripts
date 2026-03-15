import type { EnvContext } from "./context.js"
import type { HookInput } from "./types.js"

const MAX_INSTRUCTION = 300

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s
}

export function formatUserPrompt(input: HookInput, ctx: EnvContext): string {
  const header = [
    `👤 <b>Prompt</b>`,
    `📦 <b>${esc(ctx.project)}</b>`,
    `🌿 <code>${esc(ctx.branch)}</code>`,
  ].join("  ·  ")

  const line2 = [
    `📂 <code>${esc(input.cwd)}</code>`,
    ...(ctx.tmuxWindow ? [`🪟 ${esc(ctx.tmuxWindow)}`] : []),
    `🖥 ${esc(ctx.hostname)}`,
  ].join("  ·  ")

  const parts = [header, line2]

  if (input.prompt) {
    parts.push("", `<blockquote>${esc(truncate(input.prompt, MAX_INSTRUCTION))}</blockquote>`)
  }

  return parts.join("\n")
}

export function formatAssistantReply(
  input: HookInput,
  ctx: EnvContext,
  lastInstruction: string | null,
  elapsedMs?: number,
): string {
  const elapsedStr = elapsedMs !== undefined ? `⏱ ${Math.round(elapsedMs / 1000)}s` : null

  const headerParts = [`🤖 <b>Reply</b>`]
  if (elapsedStr) headerParts.push(elapsedStr)
  headerParts.push(`📦 <b>${esc(ctx.project)}</b>`)

  const header = headerParts.join("  ·  ")

  const line2 = [
    `🌿 <code>${esc(ctx.branch)}</code>`,
    ...(ctx.tmuxWindow ? [`🪟 ${esc(ctx.tmuxWindow)}`] : []),
    `🖥 ${esc(ctx.hostname)}`,
  ].join("  ·  ")

  const parts = [header, line2]

  if (lastInstruction) {
    parts.push("", `❓ <i>${esc(truncate(lastInstruction, MAX_INSTRUCTION))}</i>`)
  }

  parts.push("", `<blockquote>${esc(input.last_assistant_message ?? "")}</blockquote>`)

  return parts.join("\n")
}

export function formatNotification(
  input: HookInput,
  ctx: EnvContext,
  lastInstruction: string | null,
): string {
  return formatAssistantReply(input, ctx, lastInstruction)
}

export function formatToolActivity(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCount: number,
): string {
  const MAX_SUMMARY = 80
  let summary = ""
  if (toolName === "Edit" || toolName === "Write") {
    summary = typeof toolInput["file_path"] === "string" ? toolInput["file_path"] : ""
  } else if (toolName === "Bash") {
    summary =
      typeof toolInput["command"] === "string"
        ? truncate(toolInput["command"] as string, MAX_SUMMARY)
        : ""
  }
  const countPart = toolCount > 1 ? ` (${toolCount} tools)` : ""
  return summary
    ? `🔧 ${esc(toolName)} · <code>${esc(summary)}</code>${countPart}`
    : `🔧 ${esc(toolName)}${countPart}`
}

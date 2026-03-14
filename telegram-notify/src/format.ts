import type { EnvContext } from "./context.js"
import type { StopHookInput } from "./types.js"

const MAX_INSTRUCTION = 300

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s
}

export function formatUserPrompt(input: StopHookInput, ctx: EnvContext): string {
  const header = [
    `👤 Prompt`,
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
    parts.push("", esc(truncate(input.prompt, MAX_INSTRUCTION)))
  }

  return parts.join("\n")
}

export function formatAssistantReply(
  input: StopHookInput,
  ctx: EnvContext,
  lastInstruction: string | null,
  elapsedMs?: number,
): string {
  const elapsedStr = elapsedMs !== undefined ? `⏱ ${Math.round(elapsedMs / 1000)}s` : null

  const headerParts = [`🤖 Reply`]
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

  parts.push("", `💬 ${esc(input.last_assistant_message ?? "")}`)

  return parts.join("\n")
}

export function formatNotification(
  input: StopHookInput,
  ctx: EnvContext,
  lastInstruction: string | null,
): string {
  return formatAssistantReply(input, ctx, lastInstruction)
}

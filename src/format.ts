import type { EnvContext } from "./context.js"
import type { StopHookInput } from "./types.js"

const MAX_MESSAGE_LENGTH = 2000

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function formatNotification(input: StopHookInput, ctx: EnvContext): string {
  const lastMessage = input.last_assistant_message.length > MAX_MESSAGE_LENGTH
    ? input.last_assistant_message.slice(0, MAX_MESSAGE_LENGTH) + "\n[truncated]"
    : input.last_assistant_message

  const lines = [
    "<b>Claude Code stopped</b>",
    "",
    `<b>Project:</b>  ${esc(ctx.project)}`,
    `<b>Path:</b>     ${esc(input.cwd)}`,
    `<b>Branch:</b>   ${esc(ctx.branch)}`,
    `<b>Host:</b>     ${esc(ctx.hostname)}`,
  ]

  if (ctx.tmuxWindow !== null) {
    lines.push(`<b>Tmux:</b>     ${esc(ctx.tmuxWindow)}`)
  }

  lines.push(`<b>Session:</b>  ${esc(input.session_id)}`)

  return [
    ...lines,
    "",
    "<b>Last message:</b>",
    esc(lastMessage),
  ].join("\n")
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s
}

export function formatToolActivity(
  toolName: string,
  args: Record<string, unknown>,
  toolCount: number,
): string {
  const MAX_SUMMARY = 80
  let summary = ""

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "Edit" || toolName === "Write") {
    summary = typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
      ? args["file_path"]
      : ""
  } else if (toolName === "shell" || toolName === "Bash") {
    const cmd = args["command"] ?? args["cmd"] ?? args["script"]
    summary = typeof cmd === "string" ? truncate(cmd, MAX_SUMMARY) : ""
  } else if (toolName === "read_file" || toolName === "Read") {
    summary = typeof args["path"] === "string"
      ? args["path"]
      : typeof args["file_path"] === "string"
      ? args["file_path"]
      : ""
  }

  const countPart = toolCount > 1 ? ` (${toolCount} tools)` : ""
  return summary
    ? `🔧 ${esc(toolName)} · <code>${esc(summary)}</code>${countPart}`
    : `🔧 ${esc(toolName)}${countPart}`
}

export function formatSessionStart(
  repo: string,
  slug: string,
  task: string,
): string {
  const MAX_TASK = 200
  return [
    `⚡ <b>Session started</b>  ·  📦 <b>${esc(repo)}</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(task, MAX_TASK))}</blockquote>`,
  ].join("\n")
}

export function formatSessionComplete(
  slug: string,
  durationMs: number,
  totalTokens: number | null | undefined,
): string {
  const secs = Math.round(durationMs / 1000)
  const dur = secs >= 60
    ? `${Math.floor(secs / 60)}m ${secs % 60}s`
    : `${secs}s`

  const tokenPart = totalTokens != null ? `  ·  🪙 ${totalTokens.toLocaleString()} tokens` : ""
  return `✅ <b>Complete</b>  ·  🏷 <code>${esc(slug)}</code>  ·  ⏱ ${dur}${tokenPart}`
}

export function formatSessionError(slug: string, error: string): string {
  return [
    `❌ <b>Error</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<code>${esc(truncate(error, 300))}</code>`,
  ].join("\n")
}

export function formatSessionInterrupted(slug: string): string {
  return `⚠️ <b>Session interrupted</b>  ·  🏷 <code>${esc(slug)}</code>\nRestart not yet supported. Create a new task.`
}

export function formatAssistantText(slug: string, text: string): string {
  const MAX_TEXT = 1200
  return [
    `🤖 <b>Reply</b>  ·  🏷 <code>${esc(slug)}</code>`,
    ``,
    `<blockquote>${esc(truncate(text, MAX_TEXT))}</blockquote>`,
  ].join("\n")
}

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

function getNpmInstallBlock(dockerfile: string): string {
  const lines = dockerfile.split("\n")
  const startIdx = lines.findIndex((l) => l.includes("npm install -g"))
  if (startIdx === -1) return ""
  let block = lines[startIdx]
  let i = startIdx + 1
  while (block.trimEnd().endsWith("\\") && i < lines.length) {
    block += "\n" + lines[i]
    i++
  }
  return block
}

describe("Dockerfile", () => {
  const dockerfilePath = path.resolve(import.meta.dirname, "../Dockerfile")
  const dockerfile = fs.readFileSync(dockerfilePath, "utf-8")

  it("installs @openai/codex globally via npm", () => {
    expect(dockerfile).toContain("@openai/codex")
  })

  it("includes codex in the npm install -g command", () => {
    const npmInstallBlock = getNpmInstallBlock(dockerfile)
    expect(npmInstallBlock).toContain("@openai/codex")
  })

  it("preserves existing npm global packages alongside codex", () => {
    const npmInstallBlock = getNpmInstallBlock(dockerfile)
    expect(npmInstallBlock).toContain("@anthropic-ai/claude-code")
    expect(npmInstallBlock).toContain("@zed-industries/claude-agent-acp")
    expect(npmInstallBlock).toContain("@playwright/mcp")
    expect(npmInstallBlock).toContain("@upstash/context7-mcp")
  })
})

describe("Codex env documentation", () => {
  const envExamplePaths = [
    path.resolve(import.meta.dirname, "../.env.example"),
    path.resolve(import.meta.dirname, "../assets/templates/.env.example"),
  ]

  for (const envPath of envExamplePaths) {
    const label = path.relative(path.resolve(import.meta.dirname, ".."), envPath)

    describe(label, () => {
      const content = fs.readFileSync(envPath, "utf-8")

      it("documents OPENAI_API_KEY", () => {
        expect(content).toContain("OPENAI_API_KEY")
      })

      it("documents CODEX_EXEC_PATH", () => {
        expect(content).toContain("CODEX_EXEC_PATH")
      })

      it("documents CODEX_APPROVAL_MODE", () => {
        expect(content).toContain("CODEX_APPROVAL_MODE")
      })

      it("documents GOOSE_PROVIDER=codex option", () => {
        expect(content).toMatch(/GOOSE_PROVIDER.*codex/i)
      })
    })
  }
})

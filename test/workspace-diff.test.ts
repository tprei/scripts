import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { computeWorkspaceDiff } from "../src/session/workspace-diff.js"

const execFile = promisify(execFileCb)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@example.com",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  })
}

describe("computeWorkspaceDiff", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-diff-"))
    await git(dir, "init", "--initial-branch=main")
    await fs.writeFile(path.join(dir, "README.md"), "initial\n")
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "init")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("returns an empty patch when the tree is clean", async () => {
    const result = await computeWorkspaceDiff(dir)
    expect(result.patch).toBe("")
    expect(result.base).toBe("main")
    expect(result.truncated).toBe(false)
  })

  it("reports uncommitted changes against the base", async () => {
    await fs.writeFile(path.join(dir, "README.md"), "initial\nchanged\n")
    const result = await computeWorkspaceDiff(dir)
    expect(result.patch).toContain("+changed")
    expect(result.base).toBe("main")
  })

  it("diffs the feature branch against main when a main ref exists", async () => {
    await git(dir, "checkout", "-b", "minion/test")
    await fs.writeFile(path.join(dir, "feature.txt"), "hello\n")
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "feature")

    const result = await computeWorkspaceDiff(dir, "minion/test")
    expect(result.base).toBe("main")
    expect(result.head).toBe("minion/test")
    expect(result.patch).toContain("+hello")
    expect(result.patch).toContain("feature.txt")
  })

  it("ignores commits that landed on origin/main after the branch diverged", async () => {
    // Simulate a minion workspace cloned from a remote whose main has
    // advanced with unrelated PRs since the session's branch was created.
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-diff-remote-"))
    try {
      await git(remoteDir, "init", "--bare", "--initial-branch=main")
      await git(dir, "remote", "add", "origin", remoteDir)
      await git(dir, "push", "origin", "main")

      await git(dir, "checkout", "-b", "minion/feature")
      await fs.writeFile(path.join(dir, "feature.txt"), "hello\n")
      await git(dir, "add", ".")
      await git(dir, "commit", "-m", "branch: add feature")

      // A second clone advances `main` upstream with a large unrelated change,
      // then pushes. The first clone's `origin/main` is now stale.
      const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-diff-other-"))
      try {
        await git(otherDir, "clone", remoteDir, ".")
        const bigLines = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n") + "\n"
        await fs.writeFile(path.join(otherDir, "unrelated.txt"), bigLines)
        await git(otherDir, "add", ".")
        await git(otherDir, "commit", "-m", "main: unrelated 500-line change")
        await git(otherDir, "push", "origin", "main")
      } finally {
        await fs.rm(otherDir, { recursive: true, force: true })
      }

      const result = await computeWorkspaceDiff(dir, "minion/feature")

      expect(result.base).toBe("origin/main")
      expect(result.patch).toContain("feature.txt")
      expect(result.patch).toContain("+hello")
      // The unrelated upstream commit must not show up as inverted deletions
      // in this branch's patch.
      expect(result.patch).not.toContain("unrelated.txt")
      expect(result.patch).not.toContain("line-0")
    } finally {
      await fs.rm(remoteDir, { recursive: true, force: true })
    }
  })
})

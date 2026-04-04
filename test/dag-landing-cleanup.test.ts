import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

import { execFile } from "node:child_process"
import { cleanupMergedBranch } from "../src/dag/dag.js"

const mockExecFile = vi.mocked(execFile)

beforeEach(() => {
  mockExecFile.mockReset()
})

function mockExecFileSuccess() {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
    const callback = typeof _opts === "function" ? _opts : cb
    if (callback) callback(null, "", "")
    return {} as any
  })
}

function mockExecFileSequence(implementations: Array<(cb: (err: Error | null, stdout: string, stderr: string) => void) => void>) {
  let callIndex = 0
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
    const callback = typeof _opts === "function" ? _opts : cb
    const impl = implementations[callIndex++]
    if (impl && callback) impl(callback)
    return {} as any
  })
}

describe("cleanupMergedBranch", () => {
  it("removes worktree and deletes remote branch", async () => {
    mockExecFileSuccess()

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/test-worktree", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: true })
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/workspace/test-worktree"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
  })

  it("skips worktree removal when no worktree path provided", async () => {
    mockExecFileSuccess()

    const result = await cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
  })

  it("swallows worktree removal errors", async () => {
    mockExecFileSequence([
      (cb) => cb(new Error("not a working tree"), "", ""),
      (cb) => cb(null, "", ""),
    ])

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/gone", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
  })

  it("swallows remote branch delete errors", async () => {
    mockExecFileSequence([
      (cb) => cb(null, "", ""),
      (cb) => cb(new Error("remote ref does not exist"), "", ""),
    ])

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: false })
  })

  it("swallows both errors without throwing", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === "function" ? _opts : cb
      if (callback) callback(new Error("everything fails"), "", "")
      return {} as any
    })

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: false })
  })

  it("passes custom timeout", async () => {
    mockExecFileSuccess()

    await cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo", { timeout: 30_000 })

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.any(Array),
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    )
  })
})

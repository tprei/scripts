import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../src/ci-babysit.js", () => ({
  checkPRMergeability: vi.fn(),
  waitForCI: vi.fn(),
}))

vi.mock("../src/quality-gates.js", () => ({
  runQualityGates: vi.fn(),
}))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execSync: vi.fn() }
})

import { execSync } from "node:child_process"
import { checkPRMergeability, waitForCI } from "../src/ci-babysit.js"
import { runQualityGates } from "../src/quality-gates.js"
import {
  checkMergeConflicts,
  checkCI,
  checkTests,
  buildCompletenessReviewPrompt,
  parseCompletenessResult,
  rebaseOntoMain,
} from "../src/verification.js"
import type { CiConfig } from "../src/config-types.js"

const mockCheckPRMergeability = vi.mocked(checkPRMergeability)
const mockWaitForCI = vi.mocked(waitForCI)
const mockRunQualityGates = vi.mocked(runQualityGates)
const mockExecSync = vi.mocked(execSync)

const ciConfig: CiConfig = {
  babysitEnabled: true,
  maxRetries: 2,
  pollIntervalMs: 1000,
  pollTimeoutMs: 60000,
  dagCiPolicy: "per-node",
}

describe("checkMergeConflicts", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("returns passed when PR is mergeable", async () => {
    mockCheckPRMergeability.mockResolvedValue("MERGEABLE")
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(true)
    expect(result.state).toBe("MERGEABLE")
  })

  it("returns failed when PR has conflicts", async () => {
    mockCheckPRMergeability.mockResolvedValue("CONFLICTING")
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(false)
    expect(result.state).toBe("CONFLICTING")
    expect(result.details).toContain("merge conflicts")
  })

  it("retries on UNKNOWN and passes if second check is MERGEABLE", async () => {
    mockCheckPRMergeability
      .mockResolvedValueOnce("UNKNOWN")
      .mockResolvedValueOnce("MERGEABLE")

    const promise = checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await promise

    expect(result.passed).toBe(true)
    expect(result.state).toBe("MERGEABLE")
  })

  it("retries on UNKNOWN and fails if second check is CONFLICTING", async () => {
    mockCheckPRMergeability
      .mockResolvedValueOnce("UNKNOWN")
      .mockResolvedValueOnce("CONFLICTING")

    const promise = checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await promise

    expect(result.passed).toBe(false)
    expect(result.state).toBe("CONFLICTING")
  })

  it("returns failed when mergeability check returns null", async () => {
    mockCheckPRMergeability.mockResolvedValue(null)
    const result = await checkMergeConflicts("https://github.com/org/repo/pull/1", "/tmp")
    expect(result.passed).toBe(false)
    expect(result.state).toBeNull()
  })
})

describe("checkCI", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns passed when all CI checks pass", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: true,
      checks: [
        { name: "build", state: "success", bucket: "pass" },
        { name: "test", state: "success", bucket: "pass" },
      ],
      timedOut: false,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(true)
    expect(result.details).toContain("2 CI check(s) passed")
  })

  it("returns failed when CI checks fail", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: false,
      checks: [
        { name: "build", state: "success", bucket: "pass" },
        { name: "test", state: "failure", bucket: "fail" },
      ],
      timedOut: false,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(false)
    expect(result.details).toContain("test")
  })

  it("returns failed when CI times out", async () => {
    mockWaitForCI.mockResolvedValue({
      passed: false,
      checks: [{ name: "slow-check", state: "pending", bucket: "pending" }],
      timedOut: true,
    })

    const result = await checkCI("https://github.com/org/repo/pull/1", "/tmp", ciConfig)
    expect(result.passed).toBe(false)
    expect(result.details).toContain("timed out")
  })
})

describe("checkTests", () => {
  afterEach(() => vi.restoreAllMocks())

  it("returns passed when all quality gates pass", () => {
    mockRunQualityGates.mockReturnValue({
      allPassed: true,
      results: [
        { gate: "tests", passed: true, output: "ok" },
        { gate: "typecheck", passed: true, output: "ok" },
      ],
    })

    const result = checkTests("/tmp/repo")
    expect(result.passed).toBe(true)
    expect(result.details).toContain("tests, typecheck")
  })

  it("returns failed when a quality gate fails", () => {
    mockRunQualityGates.mockReturnValue({
      allPassed: false,
      results: [
        { gate: "tests", passed: true, output: "ok" },
        { gate: "lint", passed: false, output: "lint error" },
      ],
    })

    const result = checkTests("/tmp/repo")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("lint")
  })

  it("returns passed with message when no gates detected", () => {
    mockRunQualityGates.mockReturnValue({
      allPassed: true,
      results: [],
    })

    const result = checkTests("/tmp/repo")
    expect(result.passed).toBe(true)
    expect(result.details).toContain("No quality gates detected")
  })
})

describe("buildCompletenessReviewPrompt", () => {
  it("includes node title and description", () => {
    const prompt = buildCompletenessReviewPrompt(
      "Add auth middleware",
      "Implement JWT-based authentication",
      "feat/auth",
      "https://github.com/org/repo/pull/5",
    )
    expect(prompt).toContain("Add auth middleware")
    expect(prompt).toContain("JWT-based authentication")
    expect(prompt).toContain("feat/auth")
    expect(prompt).toContain("pull/5")
  })

  it("includes VERIFICATION PASSED sentinel", () => {
    const prompt = buildCompletenessReviewPrompt("title", "desc", "branch", "url")
    expect(prompt).toContain("VERIFICATION PASSED")
  })
})

describe("parseCompletenessResult", () => {
  it("returns passed when output contains sentinel", () => {
    const result = parseCompletenessResult("All looks good.\n\nVERIFICATION PASSED\n")
    expect(result.passed).toBe(true)
  })

  it("returns failed when output lacks sentinel", () => {
    const result = parseCompletenessResult("Found issues: missing error handling in auth flow")
    expect(result.passed).toBe(false)
  })
})

describe("rebaseOntoMain", () => {
  afterEach(() => vi.restoreAllMocks())

  function mockExecSyncSequence(responses: { ok: boolean; output: string }[]) {
    let callIndex = 0
    mockExecSync.mockImplementation(() => {
      const response = responses[callIndex++]
      if (!response || !response.ok) {
        const err = Object.assign(new Error("Command failed"), {
          stdout: Buffer.from(""),
          stderr: Buffer.from(response?.output ?? "unknown"),
        })
        throw err
      }
      return Buffer.from(response.output)
    })
  }

  it("rebases and pushes successfully", () => {
    mockExecSyncSequence([
      { ok: true, output: "" },               // git fetch origin
      { ok: true, output: "main" },            // gh repo view
      { ok: true, output: "" },                // git checkout
      { ok: true, output: "" },                // git rebase
      { ok: true, output: "" },                // git push
    ])

    const result = rebaseOntoMain("feat/my-branch", "/tmp/repo")
    expect(result.passed).toBe(true)
    expect(result.details).toContain("Rebased")
    expect(result.details).toContain("main")
  })

  it("returns failed when fetch fails", () => {
    mockExecSyncSequence([
      { ok: false, output: "network error" },
    ])

    const result = rebaseOntoMain("feat/my-branch", "/tmp/repo")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("git fetch failed")
  })

  it("returns failed when rebase has conflicts", () => {
    mockExecSyncSequence([
      { ok: true, output: "" },               // git fetch origin
      { ok: true, output: "main" },            // gh repo view
      { ok: true, output: "" },                // git checkout
      { ok: false, output: "CONFLICT" },       // git rebase
      { ok: true, output: "" },                // git rebase --abort (best-effort)
    ])

    const result = rebaseOntoMain("feat/my-branch", "/tmp/repo")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("Rebase failed")
  })

  it("returns failed when push fails after rebase", () => {
    mockExecSyncSequence([
      { ok: true, output: "" },               // git fetch origin
      { ok: true, output: "main" },            // gh repo view
      { ok: true, output: "" },                // git checkout
      { ok: true, output: "" },                // git rebase
      { ok: false, output: "rejected" },       // git push
    ])

    const result = rebaseOntoMain("feat/my-branch", "/tmp/repo")
    expect(result.passed).toBe(false)
    expect(result.details).toContain("Push failed")
  })

  it("falls back to checking main/master when gh fails", () => {
    mockExecSyncSequence([
      { ok: true, output: "" },               // git fetch origin
      { ok: false, output: "gh not found" },   // gh repo view fails
      { ok: true, output: "abc123" },          // git rev-parse --verify origin/main
      { ok: true, output: "" },                // git checkout
      { ok: true, output: "" },                // git rebase
      { ok: true, output: "" },                // git push
    ])

    const result = rebaseOntoMain("feat/my-branch", "/tmp/repo")
    expect(result.passed).toBe(true)
  })
})

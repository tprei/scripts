import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import crypto from "node:crypto"
import { cleanBuildArtifacts, dirSizeBytes, bootstrapDependencies } from "../src/dispatcher.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("cleanBuildArtifacts", () => {
  it("removes known artifact directories", () => {
    const artifacts = ["node_modules", ".next", ".turbo", ".cache", "dist", ".npm"]
    for (const name of artifacts) {
      const dir = path.join(tmpDir, name)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "file.txt"), "data")
    }

    cleanBuildArtifacts(tmpDir)

    for (const name of artifacts) {
      expect(fs.existsSync(path.join(tmpDir, name))).toBe(false)
    }
  })

  it("removes .home/.npm cache directory", () => {
    const npmCache = path.join(tmpDir, ".home", ".npm")
    fs.mkdirSync(npmCache, { recursive: true })
    fs.writeFileSync(path.join(npmCache, "cache.json"), "{}")

    cleanBuildArtifacts(tmpDir)

    expect(fs.existsSync(npmCache)).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, ".home"))).toBe(true)
  })

  it("leaves non-artifact files and directories intact", () => {
    fs.mkdirSync(path.join(tmpDir, "src"))
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "code")
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}")
    fs.mkdirSync(path.join(tmpDir, ".git"))

    cleanBuildArtifacts(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, "src", "index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(true)
  })

  it("handles missing directories gracefully", () => {
    expect(() => cleanBuildArtifacts(tmpDir)).not.toThrow()
  })

  it("handles nonexistent cwd gracefully", () => {
    expect(() => cleanBuildArtifacts(path.join(tmpDir, "nonexistent"))).not.toThrow()
  })

  it("removes nested contents within artifact dirs", () => {
    const deep = path.join(tmpDir, "node_modules", "@scope", "pkg", "lib")
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, "index.js"), "module.exports = {}")

    cleanBuildArtifacts(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, "node_modules"))).toBe(false)
  })

  it("only removes artifacts that exist, ignoring the rest", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"))
    fs.writeFileSync(path.join(tmpDir, "node_modules", "a.js"), "")

    cleanBuildArtifacts(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, "node_modules"))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, ".next"))).toBe(false)
  })
})

describe("bootstrapDependencies", () => {
  it("skips when no package.json exists", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    bootstrapDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(workDir, "node_modules"))).toBe(false)
  })

  it("hardlinks cached node_modules when lockfile hash matches", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    // Create package.json and lockfile in workDir
    fs.writeFileSync(path.join(workDir, "package.json"), '{"name":"test"}')
    const lockContent = '{"lockfileVersion":3}'
    fs.writeFileSync(path.join(workDir, "package-lock.json"), lockContent)

    // Create cached node_modules with matching hash
    const cacheDir = path.join(reposDir, "test-repo-node_modules")
    fs.mkdirSync(path.join(cacheDir, "some-pkg"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "some-pkg", "index.js"), "module.exports = 1")

    // Write matching hash
    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-lock.hash"), hash)

    bootstrapDependencies(workDir, reposDir, "test-repo")

    // node_modules should exist in workDir via hardlink copy
    expect(fs.existsSync(path.join(workDir, "node_modules", "some-pkg", "index.js"))).toBe(true)
    expect(fs.readFileSync(path.join(workDir, "node_modules", "some-pkg", "index.js"), "utf8")).toBe("module.exports = 1")
  })

  it("does not hardlink when lockfile hash differs", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    // Create package.json (no lockfile → npm install path, which will fail, but that's fine)
    fs.writeFileSync(path.join(workDir, "package.json"), '{"name":"test"}')
    fs.writeFileSync(path.join(workDir, "package-lock.json"), '{"lockfileVersion":3}')

    // Create cached node_modules with WRONG hash
    const cacheDir = path.join(reposDir, "test-repo-node_modules")
    fs.mkdirSync(path.join(cacheDir, "some-pkg"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "some-pkg", "index.js"), "old")
    fs.writeFileSync(path.join(reposDir, "test-repo-lock.hash"), "wrong-hash")

    // This will attempt npm ci which will fail (no real npm project), but should be non-fatal
    bootstrapDependencies(workDir, reposDir, "test-repo")

    // Should NOT have hardlinked the stale cache
    expect(fs.existsSync(path.join(workDir, "node_modules", "some-pkg", "index.js"))).toBe(false)
  })
})

describe("dirSizeBytes", () => {
  it("returns size > 0 for a directory with files", () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello world")

    const size = dirSizeBytes(tmpDir)
    expect(size).toBeGreaterThan(0)
  })

  it("returns 0 for a nonexistent directory", () => {
    expect(dirSizeBytes(path.join(tmpDir, "nope"))).toBe(0)
  })

  it("returns size that includes nested files", () => {
    fs.mkdirSync(path.join(tmpDir, "sub"))
    fs.writeFileSync(path.join(tmpDir, "sub", "big.txt"), "x".repeat(10000))

    const size = dirSizeBytes(tmpDir)
    expect(size).toBeGreaterThanOrEqual(10000)
  })
})

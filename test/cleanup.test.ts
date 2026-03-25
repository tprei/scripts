import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { cleanBuildArtifacts, dirSizeBytes } from "../src/dispatcher.js"

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

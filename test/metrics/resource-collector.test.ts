import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResourceCollector } from "../../src/metrics/resource-collector.js"

describe("ResourceCollector", () => {
  let tmpRoot: string
  let cgroupRoot: string
  let workspace: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resource-collector-"))
    cgroupRoot = path.join(tmpRoot, "cgroup")
    workspace = path.join(tmpRoot, "workspace")
    await fs.mkdir(cgroupRoot, { recursive: true })
    await fs.mkdir(workspace, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  const baseCallbacks = {
    getActiveSessionCount: () => 2,
    getMaxSessionCount: () => 5,
    getActiveLoopCount: () => 1,
    getMaxLoopCount: () => 3,
  }

  it("reports cgroup source when cgroup files exist", async () => {
    await fs.writeFile(
      path.join(cgroupRoot, "cpu.stat"),
      "usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\n",
      "utf-8",
    )
    await fs.writeFile(path.join(cgroupRoot, "cpu.max"), "200000 100000", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.current"), "104857600", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.max"), "524288000", "utf-8")

    const collector = new ResourceCollector({
      workspaceRoot: workspace,
      callbacks: baseCallbacks,
      cgroupRoot,
    })
    const snap = await collector.snapshot()
    expect(snap.cpu.source).toBe("cgroup")
    expect(snap.cpu.cpuCount).toBe(2)
    expect(snap.memory.source).toBe("cgroup")
    expect(snap.memory.usedBytes).toBe(104857600)
    expect(snap.memory.limitBytes).toBe(524288000)
    expect(snap.memory.rssBytes).toBeGreaterThan(0)
    expect(snap.counts).toEqual({
      activeSessions: 2,
      maxSessions: 5,
      activeLoops: 1,
      maxLoops: 3,
    })
    expect(snap.disk.path).toBe(workspace)
    expect(snap.disk.totalBytes).toBeGreaterThan(0)
  })

  it("falls back to host when memory.max is 'max'", async () => {
    await fs.writeFile(path.join(cgroupRoot, "cpu.stat"), "usage_usec 0\n", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.current"), "1024", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.max"), "max", "utf-8")

    const collector = new ResourceCollector({
      workspaceRoot: workspace,
      callbacks: baseCallbacks,
      cgroupRoot,
    })
    const snap = await collector.snapshot()
    expect(snap.memory.source).toBe("host")
    expect(snap.memory.limitBytes).toBe(os.totalmem())
    expect(snap.memory.usedBytes).toBe(1024)
  })

  it("falls back to process metrics when cgroup root is absent", async () => {
    const collector = new ResourceCollector({
      workspaceRoot: workspace,
      callbacks: baseCallbacks,
      cgroupRoot: path.join(tmpRoot, "missing"),
    })
    const snap = await collector.snapshot()
    expect(snap.cpu.source).toBe("host")
    expect(snap.memory.source).toBe("host")
    expect(snap.memory.rssBytes).toBeGreaterThan(0)
    expect(snap.memory.limitBytes).toBe(os.totalmem())
    expect(snap.cpu.cpuCount).toBeGreaterThan(0)
  })

  it("computes second-sample cpu usage delta", async () => {
    const cpuStat = path.join(cgroupRoot, "cpu.stat")
    await fs.writeFile(cpuStat, "usage_usec 0\n", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.current"), "0", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.max"), "1024", "utf-8")

    const collector = new ResourceCollector({
      workspaceRoot: workspace,
      callbacks: baseCallbacks,
      cgroupRoot,
    })
    const first = await collector.snapshot()
    expect(first.cpu.usagePercent).toBe(0)

    await new Promise((r) => setTimeout(r, 30))
    await fs.writeFile(cpuStat, "usage_usec 10000\n", "utf-8")
    const second = await collector.snapshot()
    expect(second.cpu.usagePercent).toBeGreaterThanOrEqual(0)
  })

  it("start + stop does not throw, and caches latest snapshot", async () => {
    await fs.writeFile(path.join(cgroupRoot, "cpu.stat"), "usage_usec 0\n", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.current"), "1", "utf-8")
    await fs.writeFile(path.join(cgroupRoot, "memory.max"), "2", "utf-8")

    const collector = new ResourceCollector({
      workspaceRoot: workspace,
      callbacks: baseCallbacks,
      cgroupRoot,
      intervalMs: 60,
    })
    collector.start()
    await new Promise((r) => setTimeout(r, 120))
    const snap = collector.getLatest()
    expect(snap).not.toBeNull()
    collector.stop()
  })
})

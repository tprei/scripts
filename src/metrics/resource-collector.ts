import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks"
import { loggers } from "../logger.js"
import type { ResourceSnapshot, LimitSource } from "./types.js"

const log = loggers.resourceCollector

const CGROUP_V2_ROOT = "/sys/fs/cgroup"
const DEFAULT_SAMPLE_INTERVAL_MS = 2000

export interface ResourceCollectorCallbacks {
  getActiveSessionCount(): number
  getMaxSessionCount(): number
  getActiveLoopCount(): number
  getMaxLoopCount(): number
}

export interface ResourceCollectorOptions {
  workspaceRoot: string
  callbacks: ResourceCollectorCallbacks
  intervalMs?: number
  cgroupRoot?: string
  onSnapshot?: (snapshot: ResourceSnapshot) => void
}

interface CpuSample {
  usageUsec: number
  ts: number
}

export class ResourceCollector {
  private readonly workspaceRoot: string
  private readonly callbacks: ResourceCollectorCallbacks
  private readonly intervalMs: number
  private readonly cgroupRoot: string
  private readonly onSnapshot?: (snapshot: ResourceSnapshot) => void

  private timer: ReturnType<typeof setInterval> | null = null
  private lagHistogram: IntervalHistogram | null = null
  private lastCpuSample: CpuSample | null = null
  private lastProcCpu: { user: number; system: number; ts: number } | null = null
  private latestSnapshot: ResourceSnapshot | null = null

  constructor(opts: ResourceCollectorOptions) {
    this.workspaceRoot = opts.workspaceRoot
    this.callbacks = opts.callbacks
    this.intervalMs = opts.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
    this.cgroupRoot = opts.cgroupRoot ?? CGROUP_V2_ROOT
    this.onSnapshot = opts.onSnapshot
  }

  start(): void {
    if (this.timer) return
    this.lagHistogram = monitorEventLoopDelay({ resolution: 20 })
    this.lagHistogram.enable()

    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lagHistogram?.disable()
    this.lagHistogram = null
  }

  getLatest(): ResourceSnapshot | null {
    return this.latestSnapshot
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const [cpu, memory, disk] = await Promise.all([
      this.readCpu(),
      this.readMemory(),
      this.readDisk(),
    ])

    const eventLoopLagMs = this.readEventLoopLag()

    const snapshot: ResourceSnapshot = {
      ts: Date.now(),
      cpu,
      memory,
      disk,
      eventLoopLagMs,
      counts: {
        activeSessions: this.callbacks.getActiveSessionCount(),
        maxSessions: this.callbacks.getMaxSessionCount(),
        activeLoops: this.callbacks.getActiveLoopCount(),
        maxLoops: this.callbacks.getMaxLoopCount(),
      },
    }
    this.latestSnapshot = snapshot
    return snapshot
  }

  private async tick(): Promise<void> {
    try {
      const snap = await this.snapshot()
      this.onSnapshot?.(snap)
    } catch (err) {
      log.warn({ err }, "resource collector tick failed")
    }
  }

  private readEventLoopLag(): number {
    const h = this.lagHistogram
    if (!h) return 0
    const mean = h.mean / 1_000_000
    h.reset()
    return Number.isFinite(mean) ? Math.round(mean * 100) / 100 : 0
  }

  private async readCpu(): Promise<ResourceSnapshot["cpu"]> {
    const cgroupCpu = await this.readCgroupCpu()
    if (cgroupCpu) return cgroupCpu

    const usage = process.cpuUsage()
    const now = Date.now()
    const cpuCount = os.cpus().length || 1

    if (!this.lastProcCpu) {
      this.lastProcCpu = { user: usage.user, system: usage.system, ts: now }
      return { usagePercent: 0, cpuCount, source: "host" }
    }

    const wallElapsedUs = (now - this.lastProcCpu.ts) * 1000
    const cpuElapsedUs =
      usage.user - this.lastProcCpu.user + (usage.system - this.lastProcCpu.system)
    this.lastProcCpu = { user: usage.user, system: usage.system, ts: now }

    if (wallElapsedUs <= 0) {
      return { usagePercent: 0, cpuCount, source: "host" }
    }
    const percent = (cpuElapsedUs / (wallElapsedUs * cpuCount)) * 100
    return {
      usagePercent: clamp(round2(percent), 0, 100),
      cpuCount,
      source: "host",
    }
  }

  private async readCgroupCpu(): Promise<ResourceSnapshot["cpu"] | null> {
    const statPath = `${this.cgroupRoot}/cpu.stat`
    let usageUsec: number
    try {
      const raw = await fsp.readFile(statPath, "utf-8")
      const match = raw.match(/usage_usec\s+(\d+)/)
      if (!match) return null
      usageUsec = Number(match[1])
    } catch {
      return null
    }

    const cpuCount = await this.readCgroupCpuCount()
    const now = Date.now()

    if (!this.lastCpuSample) {
      this.lastCpuSample = { usageUsec, ts: now }
      return { usagePercent: 0, cpuCount, source: "cgroup" }
    }

    const deltaUsage = usageUsec - this.lastCpuSample.usageUsec
    const deltaWallUs = (now - this.lastCpuSample.ts) * 1000
    this.lastCpuSample = { usageUsec, ts: now }

    if (deltaWallUs <= 0) return { usagePercent: 0, cpuCount, source: "cgroup" }
    const percent = (deltaUsage / (deltaWallUs * cpuCount)) * 100
    return {
      usagePercent: clamp(round2(percent), 0, 100),
      cpuCount,
      source: "cgroup",
    }
  }

  private async readCgroupCpuCount(): Promise<number> {
    try {
      const raw = await fsp.readFile(`${this.cgroupRoot}/cpu.max`, "utf-8")
      const [quotaRaw, periodRaw] = raw.trim().split(/\s+/)
      if (quotaRaw && quotaRaw !== "max" && periodRaw) {
        const quota = Number(quotaRaw)
        const period = Number(periodRaw)
        if (quota > 0 && period > 0) {
          return round2(quota / period)
        }
      }
    } catch {
      // fall through to host count
    }
    return os.cpus().length || 1
  }

  private async readMemory(): Promise<ResourceSnapshot["memory"]> {
    const rssBytes = process.memoryUsage.rss()
    const cgroup = await this.readCgroupMemory()
    if (cgroup) return { ...cgroup, rssBytes }

    return {
      usedBytes: os.totalmem() - os.freemem(),
      limitBytes: os.totalmem(),
      rssBytes,
      source: "host",
    }
  }

  private async readCgroupMemory(): Promise<
    Omit<ResourceSnapshot["memory"], "rssBytes"> | null
  > {
    let current: number
    try {
      const raw = await fsp.readFile(`${this.cgroupRoot}/memory.current`, "utf-8")
      current = Number(raw.trim())
      if (!Number.isFinite(current)) return null
    } catch {
      return null
    }

    let limit: number = os.totalmem()
    let source: LimitSource = "host"
    try {
      const raw = (await fsp.readFile(`${this.cgroupRoot}/memory.max`, "utf-8")).trim()
      if (raw !== "max") {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = parsed
          source = "cgroup"
        }
      }
    } catch {
      // leave as host fallback
    }

    return { usedBytes: current, limitBytes: limit, source }
  }

  private async readDisk(): Promise<ResourceSnapshot["disk"]> {
    try {
      const stats = await fsp.statfs(this.workspaceRoot)
      const totalBytes = stats.blocks * stats.bsize
      const freeBytes = stats.bavail * stats.bsize
      return {
        path: this.workspaceRoot,
        usedBytes: Math.max(totalBytes - freeBytes, 0),
        totalBytes,
      }
    } catch (err) {
      log.debug({ err, path: this.workspaceRoot }, "statfs failed")
      return { path: this.workspaceRoot, usedBytes: 0, totalBytes: 0 }
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function cgroupAvailable(cgroupRoot: string = CGROUP_V2_ROOT): boolean {
  try {
    return fs.existsSync(`${cgroupRoot}/cpu.stat`)
  } catch {
    return false
  }
}

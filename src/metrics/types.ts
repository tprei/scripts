export type LimitSource = "cgroup" | "host"

export interface CpuSnapshot {
  usagePercent: number
  cpuCount: number
  source: LimitSource
}

export interface MemorySnapshot {
  usedBytes: number
  limitBytes: number
  rssBytes: number
  source: LimitSource
}

export interface DiskSnapshot {
  path: string
  usedBytes: number
  totalBytes: number
}

export interface CountsSnapshot {
  activeSessions: number
  maxSessions: number
  activeLoops: number
  maxLoops: number
}

export interface ResourceSnapshot {
  ts: number
  cpu: CpuSnapshot
  memory: MemorySnapshot
  disk: DiskSnapshot
  eventLoopLagMs: number
  counts: CountsSnapshot
}

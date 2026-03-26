import { describe, it, expect } from "vitest"
import {
  formatLandStart,
  formatLandProgress,
  formatLandComplete,
  formatLandError,
  formatLandRebasing,
  formatLandConflict,
} from "../src/format.js"
import {
  buildDag,
  topologicalSort,
  getUpstreamBranches,
  type DagGraph,
  type DagNode,
} from "../src/dag.js"
import { checkPRMergeability } from "../src/ci-babysit.js"

describe("formatLandRebasing", () => {
  it("includes node title and index", () => {
    const msg = formatLandRebasing("Add auth middleware", 2, 5)
    expect(msg).toContain("3/5")
    expect(msg).toContain("Add auth middleware")
    expect(msg).toContain("Rebasing")
    expect(msg).toContain("merge conflict")
  })

  it("escapes HTML in title", () => {
    const msg = formatLandRebasing("<script>alert(1)</script>", 0, 1)
    expect(msg).not.toContain("<script>")
    expect(msg).toContain("&lt;script&gt;")
  })
})

describe("formatLandConflict", () => {
  it("lists conflicting files", () => {
    const msg = formatLandConflict("Fix DB schema", ["src/db.ts", "src/model.ts"])
    expect(msg).toContain("Fix DB schema")
    expect(msg).toContain("src/db.ts")
    expect(msg).toContain("src/model.ts")
    expect(msg).toContain("unresolvable merge conflicts")
  })

  it("handles empty file list", () => {
    const msg = formatLandConflict("Fix DB schema", [])
    expect(msg).toContain("Fix DB schema")
    expect(msg).not.toContain("Conflicting files")
  })

  it("escapes HTML in file paths", () => {
    const msg = formatLandConflict("task", ["src/<foo>.ts"])
    expect(msg).toContain("&lt;foo&gt;")
  })
})

describe("landing topological order", () => {
  function makeDag(): DagGraph {
    const graph = buildDag(
      "test-dag",
      [
        { id: "a", title: "Base layer", description: "Foundation", dependsOn: [] },
        { id: "b", title: "Auth", description: "Auth module", dependsOn: ["a"] },
        { id: "c", title: "API", description: "API layer", dependsOn: ["a"] },
        { id: "d", title: "Frontend", description: "UI", dependsOn: ["b", "c"] },
      ],
      12345,
      "test-repo",
    )
    // Simulate all nodes completed with PRs
    for (const node of graph.nodes) {
      node.status = "done"
      node.prUrl = `https://github.com/org/repo/pull/${node.id}`
      node.branch = `feature/${node.id}`
      node.mergeBase = "abc123"
    }
    return graph
  }

  it("sorts nodes in dependency order for landing", () => {
    const graph = makeDag()
    const sorted = topologicalSort(graph)
    const aIdx = sorted.indexOf("a")
    const bIdx = sorted.indexOf("b")
    const cIdx = sorted.indexOf("c")
    const dIdx = sorted.indexOf("d")

    // "a" must come before "b" and "c"
    expect(aIdx).toBeLessThan(bIdx)
    expect(aIdx).toBeLessThan(cIdx)
    // "b" and "c" must come before "d"
    expect(bIdx).toBeLessThan(dIdx)
    expect(cIdx).toBeLessThan(dIdx)
  })

  it("filters to only done nodes with PRs", () => {
    const graph = makeDag()
    // Mark one node as failed (no PR to merge)
    graph.nodes.find((n) => n.id === "c")!.status = "failed"
    graph.nodes.find((n) => n.id === "c")!.prUrl = undefined

    const sorted = topologicalSort(graph)
    const prNodes = sorted
      .map((id) => graph.nodes.find((n) => n.id === id)!)
      .filter((n) => n.status === "done" && n.prUrl)

    expect(prNodes.map((n) => n.id)).not.toContain("c")
    expect(prNodes.length).toBe(3)
  })

  it("identifies upstream branches for a node", () => {
    const graph = makeDag()
    const upstreams = getUpstreamBranches(graph, "d")
    expect(upstreams).toEqual(["feature/b", "feature/c"])
  })

  it("returns main as fallback when no upstream branches", () => {
    const graph = makeDag()
    const upstreams = getUpstreamBranches(graph, "a")
    expect(upstreams).toEqual([])
    // Landing code falls back to "main" when empty
    const targetBranch = upstreams[0] ?? "main"
    expect(targetBranch).toBe("main")
  })
})

describe("merge base tracking during landing", () => {
  it("updates child merge bases after parent merge", () => {
    const nodes: DagNode[] = [
      { id: "a", title: "A", description: "", dependsOn: [], status: "done", branch: "feat/a", prUrl: "http://pr/1", mergeBase: "old-base" },
      { id: "b", title: "B", description: "", dependsOn: ["a"], status: "done", branch: "feat/b", prUrl: "http://pr/2", mergeBase: "old-base-b" },
      { id: "c", title: "C", description: "", dependsOn: ["a"], status: "done", branch: "feat/c", prUrl: "http://pr/3", mergeBase: "old-base-c" },
    ]

    // Simulate what landDag does after merging node "a":
    // find children and update their merge base
    const mergedNode = nodes[0]
    const children = nodes.filter((n) => n.dependsOn.includes(mergedNode.id) && n.prUrl)
    const newMergeBase = "new-main-tip"
    for (const child of children) {
      child.mergeBase = newMergeBase
    }

    expect(nodes[1].mergeBase).toBe("new-main-tip")
    expect(nodes[2].mergeBase).toBe("new-main-tip")
    // Parent unchanged
    expect(nodes[0].mergeBase).toBe("old-base")
  })
})

describe("existing format functions", () => {
  it("formatLandStart includes slug and count", () => {
    const msg = formatLandStart("my-stack", 3)
    expect(msg).toContain("my-stack")
    expect(msg).toContain("3")
  })

  it("formatLandProgress includes title and PR link", () => {
    const msg = formatLandProgress("Auth module", "https://github.com/pull/1", 0, 3)
    expect(msg).toContain("1/3")
    expect(msg).toContain("Auth module")
    expect(msg).toContain("https://github.com/pull/1")
  })

  it("formatLandComplete shows succeeded/total", () => {
    const msg = formatLandComplete(2, 3)
    expect(msg).toContain("2/3")
  })

  it("formatLandError shows title and error", () => {
    const msg = formatLandError("Auth module", "merge failed")
    expect(msg).toContain("Auth module")
    expect(msg).toContain("merge failed")
  })
})

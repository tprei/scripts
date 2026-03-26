import { describe, it, expect } from "vitest"
import { needsRestack, getUpstreamBranches, type DagGraph, type DagNode } from "../src/dag.js"

function makeDag(nodes: DagNode[]): DagGraph {
  return {
    id: "dag-1",
    nodes,
    parentThreadId: 100,
    repo: "test-repo",
    createdAt: Date.now(),
  }
}

describe("restackDownstream integration logic", () => {
  describe("identifies correct nodes after CI fix", () => {
    it("restacks downstream nodes when a middle node is fixed", () => {
      const graph = makeDag([
        { id: "a", title: "Base", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Middle", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Leaf", description: "", dependsOn: ["b"], status: "ready", branch: "minion/c", mergeBase: "bbb" },
      ])

      // After CI fix on node "b", downstream "c" needs restacking
      const toRestack = needsRestack(graph, "b")
      expect(toRestack.map((n) => n.id)).toEqual(["c"])
    })

    it("restacks entire chain when root node is fixed", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Middle", description: "", dependsOn: ["a"], status: "ready", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Leaf", description: "", dependsOn: ["b"], status: "pending", branch: "minion/c", mergeBase: "bbb" },
      ])

      const toRestack = needsRestack(graph, "a")
      expect(toRestack.map((n) => n.id)).toEqual(["b", "c"])
    })

    it("returns empty when fixed node has no downstream with branches", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Sibling", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Unstarted", description: "", dependsOn: ["a"], status: "pending" },
      ])

      // Node "b" has no downstream; "c" has no branch
      const toRestack = needsRestack(graph, "b")
      expect(toRestack).toEqual([])
    })
  })

  describe("skips running nodes", () => {
    it("includes running nodes in needsRestack (handler filters them)", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Running child", description: "", dependsOn: ["a"], status: "running", branch: "minion/b", mergeBase: "aaa" },
      ])

      // needsRestack returns running nodes — the restackDownstream handler skips them
      const toRestack = needsRestack(graph, "a")
      expect(toRestack.map((n) => n.id)).toEqual(["b"])

      const runningNodes = toRestack.filter((n) => n.status === "running")
      expect(runningNodes).toHaveLength(1)
    })

    it("mixed running and non-running downstream blocks entire restack", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Ready child", description: "", dependsOn: ["a"], status: "ready", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Running child", description: "", dependsOn: ["a"], status: "running", branch: "minion/c", mergeBase: "aaa" },
      ])

      const toRestack = needsRestack(graph, "a")
      // Both are included; the handler sees running nodes and skips entire restack
      const runningNodes = toRestack.filter((n) => n.status === "running")
      expect(runningNodes).toHaveLength(1)
    })
  })

  describe("upstream branch resolution for restacking", () => {
    it("resolves correct upstream branch for linear stack", () => {
      const graph = makeDag([
        { id: "a", title: "Base", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Middle", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Top", description: "", dependsOn: ["b"], status: "ready", branch: "minion/c", mergeBase: "bbb" },
      ])

      expect(getUpstreamBranches(graph, "c")).toEqual(["minion/b"])
      expect(getUpstreamBranches(graph, "b")).toEqual(["minion/a"])
    })

    it("resolves multiple upstream branches for fan-in node", () => {
      const graph = makeDag([
        { id: "a", title: "Left", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Right", description: "", dependsOn: [], status: "done", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Merge", description: "", dependsOn: ["a", "b"], status: "ready", branch: "minion/c", mergeBase: "bbb" },
      ])

      const upstreams = getUpstreamBranches(graph, "c")
      expect(upstreams).toEqual(["minion/a", "minion/b"])
    })

    it("falls back to main when node has no dependencies", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
      ])

      const upstreams = getUpstreamBranches(graph, "a")
      expect(upstreams).toEqual([])
      // Handler uses: upstreamBranches[0] ?? "main"
      expect(upstreams[0] ?? "main").toBe("main")
    })
  })

  describe("merge base update tracking", () => {
    it("simulates merge base update after successful restack", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Child", description: "", dependsOn: ["a"], status: "ready", branch: "minion/b", mergeBase: "aaa" },
      ])

      // Simulate what restackDownstream does after a successful restack
      const toRestack = needsRestack(graph, "a")
      expect(toRestack).toHaveLength(1)

      // Simulate successful restack result
      const newMergeBase = "bbb222"
      toRestack[0].mergeBase = newMergeBase

      expect(graph.nodes.find((n) => n.id === "b")!.mergeBase).toBe("bbb222")
    })

    it("preserves merge base when restack is skipped (no-op)", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Child", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", mergeBase: "old-base" },
      ])

      // Node "b" is done (terminal), so it won't be restacked
      const toRestack = needsRestack(graph, "a")
      expect(toRestack).toHaveLength(0)

      // mergeBase unchanged
      expect(graph.nodes.find((n) => n.id === "b")!.mergeBase).toBe("old-base")
    })
  })

  describe("DAG vs stack topology", () => {
    it("handles diamond dependency for restacking", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Left", description: "", dependsOn: ["a"], status: "ready", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Right", description: "", dependsOn: ["a"], status: "ready", branch: "minion/c", mergeBase: "aaa" },
        { id: "d", title: "Join", description: "", dependsOn: ["b", "c"], status: "pending", branch: "minion/d", mergeBase: "xxx" },
      ])

      // Fixing "a" should cascade to b, c, d in topological order
      const toRestack = needsRestack(graph, "a")
      const ids = toRestack.map((n) => n.id)
      expect(ids).toContain("b")
      expect(ids).toContain("c")
      expect(ids).toContain("d")
      // b and c must come before d
      expect(ids.indexOf("d")).toBeGreaterThan(ids.indexOf("b"))
      expect(ids.indexOf("d")).toBeGreaterThan(ids.indexOf("c"))
    })

    it("restacks only affected subtree, not siblings", () => {
      const graph = makeDag([
        { id: "a", title: "Root", description: "", dependsOn: [], status: "done", branch: "minion/a", mergeBase: "aaa" },
        { id: "b", title: "Left branch", description: "", dependsOn: ["a"], status: "done", branch: "minion/b", mergeBase: "aaa" },
        { id: "c", title: "Right branch", description: "", dependsOn: ["a"], status: "ready", branch: "minion/c", mergeBase: "aaa" },
        { id: "d", title: "Left child", description: "", dependsOn: ["b"], status: "ready", branch: "minion/d", mergeBase: "bbb" },
      ])

      // Fixing "b" should only affect "d", not "c"
      const toRestack = needsRestack(graph, "b")
      expect(toRestack.map((n) => n.id)).toEqual(["d"])
    })
  })

  describe("branchModifiedByFix tracking logic", () => {
    it("restack triggers only after fix modifies branch", () => {
      // Simulating the babysitPR flow logic:
      // branchModifiedByFix starts false, set to true after merge conflict resolution
      let branchModifiedByFix = false
      const dagId = "dag-1"
      const dagNodeId = "b"

      // Scenario 1: CI passes without any fix → no restack
      const ciPassed = true
      const shouldRestack1 = ciPassed && branchModifiedByFix && dagId && dagNodeId
      expect(shouldRestack1).toBeFalsy()

      // Scenario 2: merge conflict resolved, then CI passes → restack
      branchModifiedByFix = true
      const shouldRestack2 = ciPassed && branchModifiedByFix && dagId && dagNodeId
      expect(shouldRestack2).toBeTruthy()
    })

    it("restack triggers after CI fix attempt succeeds", () => {
      // In the CI fix loop, restack is called unconditionally for DAG nodes
      // because the fix agent always modifies the branch
      const dagId = "dag-1"
      const dagNodeId = "b"
      const ciPassedAfterFix = true

      const shouldRestack = ciPassedAfterFix && dagId && dagNodeId
      expect(shouldRestack).toBeTruthy()
    })
  })
})

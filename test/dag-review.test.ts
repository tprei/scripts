import { describe, expect, it } from "vitest"
import type { PendingDagItem, SessionMode, TopicSession } from "../src/types.js"
import type { DagInput } from "../src/dag-extract.js"
import { RUN_CMD } from "../src/command-parser.js"

describe("PendingDagItem type", () => {
  it("should define a valid pending DAG item", () => {
    const item: PendingDagItem = {
      id: "task-1",
      title: "Create database schema",
      description: "Set up migrations for user tables",
      dependsOn: [],
    }
    expect(item.id).toBe("task-1")
    expect(item.dependsOn).toEqual([])
  })

  it("should support dependencies", () => {
    const item: PendingDagItem = {
      id: "task-2",
      title: "Build API",
      description: "Implement REST endpoints",
      dependsOn: ["task-1"],
    }
    expect(item.dependsOn).toContain("task-1")
  })

  it("should support multiple dependencies", () => {
    const item: PendingDagItem = {
      id: "task-3",
      title: "Integration tests",
      description: "Test full stack",
      dependsOn: ["task-1", "task-2"],
    }
    expect(item.dependsOn).toHaveLength(2)
  })
})

describe("DagInput to PendingDagItem conversion", () => {
  it("should convert DagInput to PendingDagItem", () => {
    const dagInput: DagInput = {
      id: "db-schema",
      title: "Create database schema",
      description: "Set up migrations",
      dependsOn: [],
    }

    const pendingItem: PendingDagItem = {
      id: dagInput.id,
      title: dagInput.title,
      description: dagInput.description,
      dependsOn: dagInput.dependsOn,
    }

    expect(pendingItem.id).toBe(dagInput.id)
    expect(pendingItem.title).toBe(dagInput.title)
    expect(pendingItem.description).toBe(dagInput.description)
    expect(pendingItem.dependsOn).toEqual(dagInput.dependsOn)
  })

  it("should convert DagInput with dependencies to PendingDagItem", () => {
    const dagInput: DagInput = {
      id: "api-routes",
      title: "Implement API",
      description: "Build REST endpoints",
      dependsOn: ["db-schema"],
    }

    const pendingItem: PendingDagItem = {
      id: dagInput.id,
      title: dagInput.title,
      description: dagInput.description,
      dependsOn: dagInput.dependsOn,
    }

    expect(pendingItem.dependsOn).toContain("db-schema")
  })

  it("should convert array of DagInput to array of PendingDagItem", () => {
    const dagInputs: DagInput[] = [
      { id: "step-1", title: "First", description: "D1", dependsOn: [] },
      { id: "step-2", title: "Second", description: "D2", dependsOn: ["step-1"] },
    ]

    const pendingItems: PendingDagItem[] = dagInputs.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      dependsOn: item.dependsOn,
    }))

    expect(pendingItems).toHaveLength(2)
    expect(pendingItems[0].id).toBe("step-1")
    expect(pendingItems[1].dependsOn).toContain("step-1")
  })

  it("should convert PendingDagItem back to DagInput for startDag", () => {
    const pendingItem: PendingDagItem = {
      id: "frontend",
      title: "Build UI",
      description: "React components",
      dependsOn: ["backend"],
    }

    const dagInput: DagInput = {
      id: pendingItem.id,
      title: pendingItem.title,
      description: pendingItem.description,
      dependsOn: pendingItem.dependsOn,
    }

    expect(dagInput.id).toBe(pendingItem.id)
    expect(dagInput.title).toBe(pendingItem.title)
    expect(dagInput.description).toBe(pendingItem.description)
    expect(dagInput.dependsOn).toEqual(pendingItem.dependsOn)
  })
})

describe("RUN_CMD constant", () => {
  it("should be /run", () => {
    expect(RUN_CMD).toBe("/run")
  })

  it("can be used to check command equality", () => {
    const text = "/run"
    expect(text === RUN_CMD).toBe(true)
  })

  it("can detect /run command at start of text", () => {
    const text = "/run some args"
    expect(text.startsWith(RUN_CMD)).toBe(true)
  })
})

describe("SessionMode type", () => {
  it("should include dag-review mode", () => {
    const mode: SessionMode = "dag-review"
    expect(mode).toBe("dag-review")
  })

  it("should support all session modes", () => {
    const modes: SessionMode[] = [
      "task",
      "plan",
      "think",
      "review",
      "ci-fix",
      "dag-review",
    ]
    expect(modes).toContain("dag-review")
    expect(modes).toHaveLength(6)
  })
})

describe("TopicSession with pendingDagItems", () => {
  it("should support pendingDagItems field", () => {
    const session: TopicSession = {
      threadId: 123,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [
        {
          id: "step-1",
          title: "First task",
          description: "Do the first thing",
          dependsOn: [],
        },
        {
          id: "step-2",
          title: "Second task",
          description: "Do the second thing",
          dependsOn: ["step-1"],
        },
      ],
    }

    expect(session.mode).toBe("dag-review")
    expect(session.pendingDagItems).toHaveLength(2)
    expect(session.pendingDagItems?.[0].id).toBe("step-1")
    expect(session.pendingDagItems?.[1].dependsOn).toContain("step-1")
  })

  it("should allow undefined pendingDagItems", () => {
    const session: TopicSession = {
      threadId: 456,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    expect(session.pendingDagItems).toBeUndefined()
  })

  it("should allow empty pendingDagItems array", () => {
    const session: TopicSession = {
      threadId: 789,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [],
    }

    expect(session.pendingDagItems).toEqual([])
  })

  it("should work with other session fields", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      repoUrl: "https://github.com/org/repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [
        { role: "user", text: "Create a DAG for this feature" },
        { role: "assistant", text: "Here's the proposed DAG..." },
      ],
      activeSessionId: "session-123",
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      parentThreadId: 50,
      pendingDagItems: [
        {
          id: "backend",
          title: "Backend API",
          description: "Build the API",
          dependsOn: [],
        },
        {
          id: "frontend",
          title: "Frontend UI",
          description: "Build the UI",
          dependsOn: ["backend"],
        },
      ],
    }

    expect(session.mode).toBe("dag-review")
    expect(session.parentThreadId).toBe(50)
    expect(session.conversation).toHaveLength(2)
    expect(session.pendingDagItems).toHaveLength(2)
  })
})

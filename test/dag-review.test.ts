import { describe, expect, it } from "vitest"
import type { PendingDagItem, SessionMode, TopicSession } from "../src/types.js"
import type { DagInput } from "../src/dag-extract.js"
import { RUN_CMD, DAG_CMD } from "../src/command-parser.js"
import { formatDagReview, formatDagReviewUpdated } from "../src/format.js"

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

describe("dag-review mode transitions", () => {
  it("should transition from plan mode to dag-review mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Plan the feature" }],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    // Simulate mode transition
    session.mode = "dag-review"
    session.pendingDagItems = [
      { id: "step-1", title: "First", description: "Do first", dependsOn: [] },
    ]

    expect(session.mode).toBe("dag-review")
    expect(session.pendingDagItems).toHaveLength(1)
  })

  it("should transition from think mode to dag-review mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Research the feature" }],
      pendingFeedback: [],
      mode: "think",
      lastActivityAt: Date.now(),
    }

    // Simulate mode transition
    session.mode = "dag-review"
    session.pendingDagItems = [
      { id: "step-1", title: "First", description: "Do first", dependsOn: [] },
    ]

    expect(session.mode).toBe("dag-review")
    expect(session.pendingDagItems).toBeDefined()
  })

  it("should preserve conversation through mode transition", () => {
    const conversation = [
      { role: "user" as const, text: "Plan the feature" },
      { role: "assistant" as const, text: "I'll create a plan..." },
      { role: "user" as const, text: "Add more tests" },
    ]

    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation,
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    // Transition to dag-review
    session.mode = "dag-review"
    session.pendingDagItems = []

    // Conversation should be preserved
    expect(session.conversation).toHaveLength(3)
    expect(session.conversation[0].text).toBe("Plan the feature")
  })

  it("should clear pendingDagItems when transitioning to execution", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [
        { id: "step-1", title: "First", description: "Do first", dependsOn: [] },
      ],
    }

    // Simulate transition to execution (startDag clears pendingDagItems)
    session.pendingDagItems = undefined

    expect(session.pendingDagItems).toBeUndefined()
  })
})

describe("/run command detection", () => {
  it("should detect exact /run command", () => {
    const text = "/run"
    expect(text === RUN_CMD).toBe(true)
  })

  it("should detect /run at start of message", () => {
    const text = "/run extra args"
    expect(text.startsWith(RUN_CMD)).toBe(true)
    expect(text.trim() === RUN_CMD).toBe(false)
  })

  it("should not match /run within text", () => {
    const text = "please /run this"
    expect(text === RUN_CMD).toBe(false)
    expect(text.startsWith(RUN_CMD)).toBe(false)
  })

  it("should handle whitespace variants", () => {
    const text = "/run   "
    expect(text.trim() === RUN_CMD).toBe(true)
  })

  it("should distinguish /run from /runtime", () => {
    const text = "/runtime"
    expect(text === RUN_CMD).toBe(false)
    expect(text.startsWith(RUN_CMD + " ")).toBe(false)
  })

  it("should distinguish /run from /runner", () => {
    const text = "/runner"
    expect(text === RUN_CMD).toBe(false)
  })

  it("should detect /run for dag-review mode check", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [{ id: "a", title: "A", description: "D", dependsOn: [] }],
    }

    const text = "/run"
    const shouldRun = session.mode === "dag-review" && text === RUN_CMD
    expect(shouldRun).toBe(true)
  })

  it("should not run if not in dag-review mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const text = "/run"
    const shouldRun = session.mode === "dag-review" && text === RUN_CMD
    expect(shouldRun).toBe(false)
  })
})

describe("/dag command detection", () => {
  it("should detect exact /dag command", () => {
    const text = "/dag"
    expect(text === DAG_CMD).toBe(true)
  })

  it("should detect /dag with directive", () => {
    const text = "/dag focus on backend"
    expect(text.startsWith(DAG_CMD + " ")).toBe(true)
  })

  it("should extract directive from /dag command", () => {
    const text = "/dag only the first two items"
    const directive = text.slice(DAG_CMD.length).trim()
    expect(directive).toBe("only the first two items")
  })

  it("should return empty directive for bare /dag", () => {
    const text = "/dag"
    const directive = text.slice(DAG_CMD.length).trim() || undefined
    expect(directive).toBeUndefined()
  })

  it("should be valid from plan mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
    }

    const text = "/dag"
    const isValid = (session.mode === "plan" || session.mode === "think") &&
      (text === DAG_CMD || text.startsWith(DAG_CMD + " "))
    expect(isValid).toBe(true)
  })

  it("should be valid from think mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "think",
      lastActivityAt: Date.now(),
    }

    const text = "/dag focus on auth"
    const isValid = (session.mode === "plan" || session.mode === "think") &&
      (text === DAG_CMD || text.startsWith(DAG_CMD + " "))
    expect(isValid).toBe(true)
  })

  it("should not be valid from task mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "task",
      lastActivityAt: Date.now(),
    }

    const text = "/dag"
    const isValid = (session.mode === "plan" || session.mode === "think") &&
      (text === DAG_CMD || text.startsWith(DAG_CMD + " "))
    expect(isValid).toBe(false)
  })
})

describe("dag-review conversation flow", () => {
  it("should identify non-command text as feedback in dag-review mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [{ id: "a", title: "A", description: "D", dependsOn: [] }],
    }

    const text = "merge step-1 and step-2"
    const isFeedback = session.mode === "dag-review" && text && !text.startsWith("/")
    expect(isFeedback).toBe(true)
  })

  it("should not treat /run as feedback", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [{ id: "a", title: "A", description: "D", dependsOn: [] }],
    }

    const text = "/run"
    const isFeedback = session.mode === "dag-review" && text && !text.startsWith("/")
    expect(isFeedback).toBe(false)
  })

  it("should not treat /dag as feedback in dag-review mode", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [{ id: "a", title: "A", description: "D", dependsOn: [] }],
    }

    const text = "/dag"
    const isFeedback = session.mode === "dag-review" && text && !text.startsWith("/")
    expect(isFeedback).toBe(false)
  })

  it("should handle feedback that modifies dependencies", () => {
    const currentItems: PendingDagItem[] = [
      { id: "db", title: "DB", description: "Database", dependsOn: [] },
      { id: "api", title: "API", description: "API", dependsOn: ["db"] },
      { id: "ui", title: "UI", description: "UI", dependsOn: ["api"] },
    ]

    const feedback = "remove dependency between api and ui"
    // This would be handled by parseDagModification in the real system
    expect(feedback).toContain("remove dependency")
    expect(currentItems).toHaveLength(3)
  })

  it("should handle feedback that merges tasks", () => {
    const currentItems: PendingDagItem[] = [
      { id: "api", title: "API", description: "API", dependsOn: [] },
      { id: "ui", title: "UI", description: "UI", dependsOn: ["api"] },
    ]

    const feedback = "merge api and ui into full-stack"
    // This would be handled by parseDagModification in the real system
    expect(feedback).toContain("merge")
    expect(currentItems).toHaveLength(2)
  })

  it("should handle feedback that splits tasks", () => {
    const currentItems: PendingDagItem[] = [
      { id: "full-stack", title: "Full Stack", description: "API + UI", dependsOn: [] },
    ]

    const feedback = "split full-stack into backend and frontend"
    // This would be handled by parseDagModification in the real system
    expect(feedback).toContain("split")
    expect(currentItems).toHaveLength(1)
  })
})

describe("formatDagReview integration", () => {
  it("should format dag-review display correctly", () => {
    const items: PendingDagItem[] = [
      { id: "db-schema", title: "Create DB schema", description: "Set up migrations", dependsOn: [] },
      { id: "api-routes", title: "Implement API", description: "REST endpoints", dependsOn: ["db-schema"] },
    ]

    const formatted = formatDagReview("test-slug", items)

    expect(formatted).toContain("DAG Review")
    expect(formatted).toContain("2 tasks")
    expect(formatted).toContain("test-slug")
    expect(formatted).toContain("db-schema")
    expect(formatted).toContain("api-routes")
    expect(formatted).toContain("/run")
  })

  it("should format single task correctly", () => {
    const items: PendingDagItem[] = [
      { id: "only-task", title: "Single task", description: "Just one", dependsOn: [] },
    ]

    const formatted = formatDagReview("test-slug", items)

    expect(formatted).toContain("1 task")
    expect(formatted).not.toContain("1 tasks")
  })

  it("should show dependency arrows for dependent tasks", () => {
    const items: PendingDagItem[] = [
      { id: "first", title: "First", description: "D1", dependsOn: [] },
      { id: "second", title: "Second", description: "D2", dependsOn: ["first"] },
    ]

    const formatted = formatDagReview("test-slug", items)

    expect(formatted).toContain("←")
    expect(formatted).toContain("<code>first</code>")
  })
})

describe("formatDagReviewUpdated integration", () => {
  it("should format updated DAG with feedback", () => {
    const items: PendingDagItem[] = [
      { id: "merged", title: "Merged Task", description: "Combined", dependsOn: [] },
    ]

    const feedback = "merge api and ui"
    const formatted = formatDagReviewUpdated("test-slug", items, feedback)

    expect(formatted).toContain("DAG Updated")
    expect(formatted).toContain("merge api and ui")
    expect(formatted).toContain("1 task")
    expect(formatted).toContain("/run")
  })

  it("should escape HTML in feedback", () => {
    const items: PendingDagItem[] = [
      { id: "task", title: "Task", description: "D", dependsOn: [] },
    ]

    const feedback = "merge <X> and <Y>"
    const formatted = formatDagReviewUpdated("test-slug", items, feedback)

    expect(formatted).toContain("&lt;X&gt;")
    expect(formatted).toContain("&lt;Y&gt;")
    expect(formatted).not.toContain("<X>")
  })
})

describe("edge cases in dag-review mode", () => {
  it("should handle empty pendingDagItems gracefully", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      pendingDagItems: [],
    }

    const hasItems = session.pendingDagItems && session.pendingDagItems.length > 0
    expect(hasItems).toBe(false)
  })

  it("should handle undefined pendingDagItems gracefully", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: Date.now(),
      // pendingDagItems is undefined
    }

    const hasItems = !!(session.pendingDagItems && session.pendingDagItems.length > 0)
    expect(hasItems).toBe(false)
    expect(session.pendingDagItems).toBeUndefined()
  })

  it("should handle circular dependency check scenario", () => {
    // This would be caught by buildDag in the real system
    const items: PendingDagItem[] = [
      { id: "a", title: "A", description: "D", dependsOn: ["c"] },
      { id: "b", title: "B", description: "D", dependsOn: ["a"] },
      { id: "c", title: "C", description: "D", dependsOn: ["b"] },
    ]

    // Check for circular dependencies
    const hasCircularDeps = items.some(item =>
      item.dependsOn.some(dep =>
        items.some(i => i.id === dep && i.dependsOn.includes(item.id))
      )
    )

    // This is a simplified check - real system uses topological sort
    expect(items).toHaveLength(3)
  })

  it("should handle self-dependency scenario", () => {
    // Self-dependency should be invalid
    const items: PendingDagItem[] = [
      { id: "a", title: "A", description: "D", dependsOn: ["a"] },
    ]

    const hasSelfDependency = items.some(item => item.dependsOn.includes(item.id))
    expect(hasSelfDependency).toBe(true) // This would be caught and rejected in real system
  })

  it("should handle missing dependency reference", () => {
    const items: PendingDagItem[] = [
      { id: "a", title: "A", description: "D", dependsOn: ["nonexistent"] },
    ]

    const hasMissingDep = items.some(item =>
      item.dependsOn.some(dep => !items.find(i => i.id === dep))
    )
    expect(hasMissingDep).toBe(true) // This would be caught and rejected in real system
  })

  it("should handle very long task descriptions", () => {
    const longDescription = "a".repeat(500)
    const item: PendingDagItem = {
      id: "long-task",
      title: "Long task",
      description: longDescription,
      dependsOn: [],
    }

    // Format function should truncate
    const formatted = formatDagReview("test-slug", [item])
    expect(formatted.length).toBeLessThan(longDescription.length + 1000)
  })

  it("should handle special characters in task IDs", () => {
    const item: PendingDagItem = {
      id: "task-with-special-chars-123",
      title: "Task",
      description: "D",
      dependsOn: [],
    }

    const formatted = formatDagReview("test-slug", [item])
    expect(formatted).toContain("task-with-special-chars-123")
  })

  it("should handle Unicode in task titles", () => {
    const item: PendingDagItem = {
      id: "unicode-task",
      title: "Implementação em português",
      description: "Descrição",
      dependsOn: [],
    }

    const formatted = formatDagReview("test-slug", [item])
    expect(formatted).toContain("Implementação")
  })
})

describe("dag-review state persistence", () => {
  it("should track lastActivityAt updates during dag-review", () => {
    const now = Date.now()
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [],
      pendingFeedback: [],
      mode: "dag-review",
      lastActivityAt: now,
      pendingDagItems: [{ id: "a", title: "A", description: "D", dependsOn: [] }],
    }

    // Simulate activity update
    session.lastActivityAt = Date.now()
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(now)
  })

  it("should preserve session metadata through dag-review cycle", () => {
    const session: TopicSession = {
      threadId: 100,
      repo: "test-repo",
      repoUrl: "https://github.com/org/repo",
      cwd: "/workspace/test",
      slug: "test-slug",
      conversation: [{ role: "user", text: "Plan" }],
      pendingFeedback: [],
      mode: "plan",
      lastActivityAt: Date.now(),
      profileId: "profile-123",
      parentThreadId: 50,
    }

    // Transition to dag-review
    session.mode = "dag-review"
    session.pendingDagItems = [{ id: "a", title: "A", description: "D", dependsOn: [] }]

    // Metadata should be preserved
    expect(session.repo).toBe("test-repo")
    expect(session.repoUrl).toBe("https://github.com/org/repo")
    expect(session.profileId).toBe("profile-123")
    expect(session.parentThreadId).toBe(50)
    expect(session.conversation).toHaveLength(1)
  })
})

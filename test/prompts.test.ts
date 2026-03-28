import { describe, it, expect } from "vitest"
import {
  DEFAULT_TASK_PROMPT,
  DEFAULT_RECOVERY_PROMPT,
  DEFAULT_CI_FIX_PROMPT,
  DEFAULT_PLAN_PROMPT,
  DEFAULT_THINK_PROMPT,
  DEFAULT_REVIEW_PROMPT,
  DEFAULT_SHIP_PROMPT,
  DEFAULT_PROMPTS,
} from "../src/prompts.js"

describe("prompts", () => {
  describe("DEFAULT_PROMPTS", () => {
    it("contains all required prompt types", () => {
      expect(DEFAULT_PROMPTS).toHaveProperty("task")
      expect(DEFAULT_PROMPTS).toHaveProperty("ci_fix")
      expect(DEFAULT_PROMPTS).toHaveProperty("plan")
      expect(DEFAULT_PROMPTS).toHaveProperty("think")
      expect(DEFAULT_PROMPTS).toHaveProperty("review")
      expect(DEFAULT_PROMPTS).toHaveProperty("ship")
    })

    it("maps each prompt type to the correct constant", () => {
      expect(DEFAULT_PROMPTS.task).toBe(DEFAULT_TASK_PROMPT)
      expect(DEFAULT_PROMPTS.ci_fix).toBe(DEFAULT_CI_FIX_PROMPT)
      expect(DEFAULT_PROMPTS.plan).toBe(DEFAULT_PLAN_PROMPT)
      expect(DEFAULT_PROMPTS.think).toBe(DEFAULT_THINK_PROMPT)
      expect(DEFAULT_PROMPTS.review).toBe(DEFAULT_REVIEW_PROMPT)
      expect(DEFAULT_PROMPTS.ship).toBe(DEFAULT_SHIP_PROMPT)
    })
  })

  describe("DEFAULT_SHIP_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof DEFAULT_SHIP_PROMPT).toBe("string")
      expect(DEFAULT_SHIP_PROMPT.length).toBeGreaterThan(0)
    })

    it("describes the ship minion role", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("ship minion")
      expect(DEFAULT_SHIP_PROMPT).toContain("research")
      expect(DEFAULT_SHIP_PROMPT).toContain("architecture")
      expect(DEFAULT_SHIP_PROMPT).toContain("planning")
    })

    it("enforces read-only mode", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("READ-ONLY")
      expect(DEFAULT_SHIP_PROMPT).toContain("Edit, Write, and NotebookEdit tools have been disabled")
    })

    it("requires reading repo guidelines", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("CLAUDE.md")
      expect(DEFAULT_SHIP_PROMPT).toContain("CONTRIBUTING.md")
      expect(DEFAULT_SHIP_PROMPT).toContain("README.md")
      expect(DEFAULT_SHIP_PROMPT).toContain("repo guidelines")
    })

    it("enforces web searching", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("WebSearch")
      expect(DEFAULT_SHIP_PROMPT).toContain("WebFetch")
      expect(DEFAULT_SHIP_PROMPT).toContain("Web search")
    })

    it("mentions all required agents", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("explorer")
      expect(DEFAULT_SHIP_PROMPT).toContain("technical-architect")
      expect(DEFAULT_SHIP_PROMPT).toContain("planner")
    })

    it("requires dependency-aware planning", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("Dependencies")
      expect(DEFAULT_SHIP_PROMPT).toContain("dependency-aware")
      expect(DEFAULT_SHIP_PROMPT).toContain("parallel")
    })

    it("includes structured output format for work items", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("### <item-name>")
      expect(DEFAULT_SHIP_PROMPT).toContain("**Description**")
      expect(DEFAULT_SHIP_PROMPT).toContain("**Files**")
      expect(DEFAULT_SHIP_PROMPT).toContain("**Dependencies**")
      expect(DEFAULT_SHIP_PROMPT).toContain("**Risk level**")
    })

    it("includes browser tools guidance", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("Playwright MCP tools")
      expect(DEFAULT_SHIP_PROMPT).toContain("browser_navigate")
    })

    it("includes extended thinking guidance", () => {
      expect(DEFAULT_SHIP_PROMPT).toContain("extended thinking")
    })
  })
})

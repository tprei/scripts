import { describe, it, expect } from "vitest"
import { parseHash, buildHash } from "../src/routing/route.js"

describe("parseHash", () => {
  it("parses session route", () => {
    expect(parseHash("#/s/cool-fox")).toEqual({ type: "session", sessionSlug: "cool-fox" })
  })

  it("parses group route", () => {
    expect(parseHash("#/g/abc123")).toEqual({ type: "group", groupId: "abc123" })
  })

  it("returns home for root hash", () => {
    expect(parseHash("#/")).toEqual({ type: "home" })
  })

  it("returns home for empty hash", () => {
    expect(parseHash("")).toEqual({ type: "home" })
  })

  it("returns home for unknown hash", () => {
    expect(parseHash("#/unknown")).toEqual({ type: "home" })
  })

  it("decodes URI-encoded slugs", () => {
    expect(parseHash("#/s/hello%20world")).toEqual({ type: "session", sessionSlug: "hello world" })
  })
})

describe("buildHash", () => {
  it("builds session hash", () => {
    expect(buildHash({ type: "session", sessionSlug: "cool-fox" })).toBe("#/s/cool-fox")
  })

  it("builds group hash", () => {
    expect(buildHash({ type: "group", groupId: "abc123" })).toBe("#/g/abc123")
  })

  it("builds home hash", () => {
    expect(buildHash({ type: "home" })).toBe("#/")
  })

  it("round-trips through parse and build", () => {
    const route = { type: "session" as const, sessionSlug: "test-slug" }
    expect(parseHash(buildHash(route))).toEqual(route)
  })
})

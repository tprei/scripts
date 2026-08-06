import { describe, it, expect } from "vitest"
import { hasFeature } from "../src/api/features.js"

describe("hasFeature", () => {
  it("returns true when feature is present", () => {
    const store = { features: ["web-push", "auth"] }
    expect(hasFeature(store, "web-push")).toBe(true)
    expect(hasFeature(store, "auth")).toBe(true)
  })

  it("returns false when feature is absent", () => {
    const store = { features: ["auth"] }
    expect(hasFeature(store, "web-push")).toBe(false)
  })

  it("returns false for empty feature list", () => {
    const store = { features: [] }
    expect(hasFeature(store, "messages")).toBe(false)
  })
})

import { describe, it, expect } from "vitest"
import { CappedStderrBuffer } from "../../src/session/capped-stderr-buffer.js"

describe("CappedStderrBuffer", () => {
  it("starts empty", () => {
    const buf = new CappedStderrBuffer()
    expect(buf.toString()).toBe("")
    expect(buf.byteLength).toBe(0)
  })

  it("accumulates pushed text", () => {
    const buf = new CappedStderrBuffer()
    buf.push("hello ")
    buf.push("world")
    expect(buf.toString()).toBe("hello world")
  })

  it("tracks byteLength correctly", () => {
    const buf = new CappedStderrBuffer()
    buf.push("abc")
    expect(buf.byteLength).toBe(3)
    buf.push("def")
    expect(buf.byteLength).toBe(6)
  })

  it("evicts oldest chunks when capacity is exceeded", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aaaa") // 4 bytes
    buf.push("bbbb") // 4 bytes, total 8
    buf.push("cccc") // 4 bytes, would be 12 — evict "aaaa" then fits at 8
    expect(buf.toString()).toBe("bbbbcccc")
    expect(buf.byteLength).toBe(8)
  })

  it("truncates a single chunk that exceeds maxBytes", () => {
    const buf = new CappedStderrBuffer(5)
    buf.push("abcdefghij") // 10 bytes, exceeds 5
    // keeps last 5 characters
    expect(buf.toString()).toBe("fghij")
    expect(buf.byteLength).toBe(5)
  })

  it("evicts multiple old chunks to make room", () => {
    const buf = new CappedStderrBuffer(10)
    buf.push("aa") // 2
    buf.push("bb") // 2, total 4
    buf.push("cc") // 2, total 6
    buf.push("dddddddd") // 8, would be 14 — evict aa+bb to get to 2+8=10
    expect(buf.toString()).toBe("ccdddddddd")
    expect(buf.byteLength).toBe(10)
  })

  it("handles multi-byte characters in byteLength", () => {
    const buf = new CappedStderrBuffer(10)
    const emoji = "😀" // 4 bytes in UTF-8
    buf.push(emoji)
    expect(buf.byteLength).toBe(4)
  })

  it("uses default capacity of 64KB", () => {
    const buf = new CappedStderrBuffer()
    const chunk = "x".repeat(1024) // 1KB
    for (let i = 0; i < 64; i++) {
      buf.push(chunk)
    }
    expect(buf.byteLength).toBe(64 * 1024)
    // one more push should evict
    buf.push(chunk)
    expect(buf.byteLength).toBeLessThanOrEqual(64 * 1024)
  })
})

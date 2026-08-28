import { describe, expect, test } from "bun:test"
import { HighlightCache } from "../../../src/review/git/highlight/highlight-cache"
import type { HighlightPayload } from "../../../src/review/git/highlight/highlight-payload"

function makePayload(fileKey: string): HighlightPayload {
  return {
    fileKey,
    language: "ts",
    deletionLines: [[{ text: "const x", fg: "#ff0000" }]],
    additionLines: [[{ text: "const y", fg: "#00ff00" }]],
    theme: "dark",
  }
}

describe("HighlightCache", () => {
  test("cache hit within same generation, miss after generation change", () => {
    const cache = new HighlightCache(5)
    const p1 = makePayload("foo.ts")
    const key1 = cache.cacheKey("foo.ts", "cid1", "gen1", "dark")
    cache.set(key1, p1)
    expect(cache.get(key1)).toEqual(p1)
    const keyGen2 = cache.cacheKey("foo.ts", "cid1", "gen2", "dark")
    expect(cache.get(keyGen2)).toBeUndefined()
  })

  test("LRU evicts oldest when over capacity", () => {
    const cache = new HighlightCache(2)
    cache.set(cache.cacheKey("a.ts", "cid1", "gen1", "dark"), makePayload("a.ts"))
    cache.set(cache.cacheKey("b.ts", "cid1", "gen1", "dark"), makePayload("b.ts"))
    cache.set(cache.cacheKey("c.ts", "cid1", "gen1", "dark"), makePayload("c.ts"))
    expect(cache.get(cache.cacheKey("a.ts", "cid1", "gen1", "dark"))).toBeUndefined()
    expect(cache.get(cache.cacheKey("b.ts", "cid1", "gen1", "dark"))).toBeDefined()
    expect(cache.get(cache.cacheKey("c.ts", "cid1", "gen1", "dark"))).toBeDefined()
  })

  test("different theme keys are distinct", () => {
    const cache = new HighlightCache(5)
    const p = makePayload("foo.ts")
    cache.set(cache.cacheKey("foo.ts", "cid1", "gen1", "dark"), p)
    expect(cache.get(cache.cacheKey("foo.ts", "cid1", "gen1", "light"))).toBeUndefined()
  })

  test("invalidate by generation removes matching entries", () => {
    const cache = new HighlightCache(5)
    cache.set(cache.cacheKey("a.ts", "cid1", "gen1", "dark"), makePayload("a.ts"))
    cache.set(cache.cacheKey("b.ts", "cid1", "gen2", "dark"), makePayload("b.ts"))
    cache.invalidateGeneration("gen1")
    expect(cache.get(cache.cacheKey("a.ts", "cid1", "gen1", "dark"))).toBeUndefined()
    expect(cache.get(cache.cacheKey("b.ts", "cid1", "gen2", "dark"))).toBeDefined()
  })
})

import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewIntent } from "../../../src/review/core/intents"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { visibleReviewFiles } from "../../../src/review/core/selectors"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
}
function makeGeneration() {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" })
}
function makeFile(overrides: Partial<ReviewFile> & { key: string; path: string }): ReviewFile {
  return {
    kind: "modified",
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${overrides.key}`,
    patchDigest: `patch-${overrides.key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [],
    source: "available",
    ...overrides,
  }
}
function makeDoc(files: ReviewFile[], commits: readonly { oid: string; parents: readonly string[]; author: string; timestamp: number; subject: string; body: string }[] = [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" }]): ReviewDocument {
  return createReviewDocument({ identity: makeIdentity(), generation: makeGeneration(), commits: commits as unknown as ReviewDocument["commits"], files })
}

describe("semantic-only state and explicit reveal tokens", () => {
  test("select-file increments fileTopToken and revision", () => {
    const doc = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts" }), makeFile({ key: "src/b.ts", path: "src/b.ts" })])
    const state = createInitialReviewState(doc)
    const action = planReviewIntent(state, { type: "selection/select-file", fileKey: "src/b.ts" })
    const next = reduceReviewState(state, action)
    expect(next.selection).toEqual({ fileKey: "src/b.ts", hunkIndex: 0 })
    expect(next.reveal.fileTopToken).toBe(state.reveal.fileTopToken + 1)
    expect(next.revision).toBe(state.revision + 1)
    expect(Object.keys(next)).not.toContain("scrollOffset")
  })

  test("explicit reselection increments reveal even when same file", () => {
    const doc = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts" }), makeFile({ key: "src/b.ts", path: "src/b.ts" })])
    const s0 = createInitialReviewState(doc)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "selection/select-file", fileKey: "src/a.ts" }))
    // s0 already at src/a.ts, reselecting same file should still bump token
    expect(s1.reveal.fileTopToken).toBe(s0.reveal.fileTopToken + 1)
    expect(s1.revision).toBe(s0.revision + 1)
    const s2 = reduceReviewState(s1, planReviewIntent(s1, { type: "selection/select-file", fileKey: "src/a.ts" }))
    expect(s2.reveal.fileTopToken).toBe(s1.reveal.fileTopToken + 1)
  })

  test("passive viewport anchoring does not increment reveal", () => {
    const doc = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", hunks: [] as any }), makeFile({ key: "src/b.ts", path: "src/b.ts", hunks: [] as any })])
    const s0 = createInitialReviewState(doc)
    expect(s0.selection.fileKey).toBe("src/a.ts")
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "selection/viewport-anchor", fileKey: "src/b.ts", hunkIndex: 0 }))
    expect(s1.selection).toEqual({ fileKey: "src/b.ts", hunkIndex: 0 })
    expect(s1.reveal.fileTopToken).toBe(s0.reveal.fileTopToken)
    expect(s1.reveal.hunkToken).toBe(s0.reveal.hunkToken)
    expect(s1.revision).toBe(s0.revision + 1)
    // anchoring to same position is no-op (same object)
    const s2 = reduceReviewState(s1, planReviewIntent(s1, { type: "selection/viewport-anchor", fileKey: "src/b.ts", hunkIndex: 0 }))
    expect(s2).toBe(s1)
  })
  test("explicit viewport anchoring requests a repeatable hunk reveal", () => {
    const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["+x"] })
    const doc = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", hunks: [hunk] })])
    const s0 = createInitialReviewState(doc)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, {
      type: "selection/viewport-anchor",
      fileKey: "src/a.ts",
      hunkIndex: 0,
      reveal: "hunk",
    }))
    expect(s1.reveal.hunkToken).toBe(s0.reveal.hunkToken + 1)
    const s2 = reduceReviewState(s1, planReviewIntent(s1, {
      type: "selection/viewport-anchor",
      fileKey: "src/a.ts",
      hunkIndex: 0,
      reveal: "hunk",
    }))
    expect(s2.reveal.hunkToken).toBe(s1.reveal.hunkToken + 1)
  })

  test("filter normalization preserves document order and matches normalized paths", () => {
    const doc = makeDoc([
      makeFile({ key: "a", path: "src/foo.ts" }),
      makeFile({ key: "b", path: "src/Bar.ts" }),
      makeFile({ key: "c", path: "src/baz.ts", previousPath: "src/OldBaz.ts" }),
    ])
    const s0 = createInitialReviewState(doc)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "filter/set-query", query: "  bar  " }))
    expect(s1.filter.query).toBe("bar")
    const visible = visibleReviewFiles(s1).map((f) => f.key)
    expect(visible).toEqual(["b"])
    // case-insensitive previousPath match
    const s2 = reduceReviewState(s0, planReviewIntent(s0, { type: "filter/set-query", query: "oldbaz" }))
    expect(visibleReviewFiles(s2).map((f) => f.key)).toEqual(["c"])
    // no-op when same normalized query
    const s3 = reduceReviewState(s1, planReviewIntent(s1, { type: "filter/set-query", query: "bar" }))
    expect(s3).toBe(s1)
    const s4 = reduceReviewState(s1, planReviewIntent(s1, { type: "filter/set-query", query: "  bar " }))
    expect(s4).toBe(s1)
  })

  test("empty documents produce null selection and handle moves", () => {
    const doc = makeDoc([])
    const s0 = createInitialReviewState(doc)
    expect(s0.selection).toEqual({ fileKey: null, hunkIndex: 0 })
    expect(s0.revision).toBe(0)
    // filter no-op still preserves empty
    expect(visibleReviewFiles(s0)).toEqual([])
    // move on empty is no-op same object
    const moved = reduceReviewState(s0, planReviewIntent(s0, { type: "selection/move", unit: "file", direction: "next" }))
    expect(moved).toBe(s0)
    const movedHunk = reduceReviewState(s0, planReviewIntent(s0, { type: "selection/move", unit: "hunk", direction: "next" }))
    expect(movedHunk).toBe(s0)
  })

  test("semantic no-op returns same object except explicit reveal", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts" })])
    const s0 = createInitialReviewState(doc)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "filter/set-query", query: "" }))
    expect(s1).toBe(s0)
    const s2 = reduceReviewState(s0, planReviewIntent(s0, { type: "filter/set-scope", scope: "all" }))
    expect(s2).toBe(s0)
    const s3 = reduceReviewState(s0, planReviewIntent(s0, { type: "projection/set", projection: { kind: "aggregate" } }))
    expect(s3).toBe(s0)
  })

  test("scrollOffset never appears on state", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts" })])
    const s0 = createInitialReviewState(doc)
    expect(Object.keys(s0)).not.toContain("scrollOffset")
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "filter/set-query", query: "a" }))
    expect(Object.keys(s1)).not.toContain("scrollOffset")
  })

  test("validates file keys, hunk bounds, and projection preconditions", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts", hunks: [{ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["+x"], digest: "d" } as any] })], [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as any])
    const s0 = createInitialReviewState(doc)
    expect(() => planReviewIntent(s0, { type: "selection/select-file", fileKey: "missing" })).toThrow()
    expect(() => planReviewIntent(s0, { type: "selection/viewport-anchor", fileKey: "a", hunkIndex: 5 })).toThrow()
    expect(() => planReviewIntent(s0, { type: "projection/set", projection: { kind: "commit", oid: "nope" } })).toThrow()
    expect(() => planReviewIntent(s0, { type: "gap/toggle", fileKey: "missing", gapId: "g1" })).toThrow()
    expect(() => planReviewIntent(s0, { type: "gap/toggle", fileKey: "a", gapId: "" })).toThrow()
  })
})

describe("ledger transitions", () => {
  const anchor = { kind: "file" as const, fileKey: "a", contentId: "content-a" }
  function feedback(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      kind: "note" as const,
      severity: "comment" as const,
      body: `body ${id}`,
      anchor,
      resolution: "active" as const,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
      ...overrides,
    }
  }
  function stateWith(items: ReturnType<typeof feedback>[]) {
    const doc = createReviewDocument({
      identity: makeIdentity(),
      generation: makeGeneration(),
      commits: [],
      files: [makeFile({ key: "a", path: "a" })],
    })
    return { ...createInitialReviewState(doc), feedback: items }
  }

  test("one handoff stamps every listed item with the same checkpoint", () => {
    const state = stateWith([feedback("one"), feedback("two")])
    const next = reduceReviewState(state, {
      type: "feedback/handoff",
      items: [{ id: "one" }, { id: "two", excerpt: ["const x = 1"] }],
      at: "2026-09-08T01:00:00.000Z",
      headOid: "h1",
    })
    expect(next.feedback.map((f) => f.status)).toEqual(["handed-off", "handed-off"])
    expect(next.feedback[0]!.handoff).toEqual({ at: "2026-09-08T01:00:00.000Z", headOid: "h1", contentId: "content-a" })
    // The excerpt is the evidence of what was objected to, and only travels when captured.
    expect(next.feedback[1]!.handoff?.excerpt).toEqual(["const x = 1"])
    expect(next.feedback[0]!.handoff).not.toHaveProperty("excerpt")
    expect(next.revision).toBe(state.revision + 1)
  })
  test("does not hand off feedback whose anchor is already stale", () => {
    const state = stateWith([feedback("stale", { resolution: "stale" })])
    const next = reduceReviewState(state, {
      type: "feedback/handoff",
      items: [{ id: "stale" }],
      at: "2026-09-08T01:00:00.000Z",
      headOid: "h1",
    })
    expect(next).toBe(state)
  })
  test("re-anchoring a handed-off objection opens a fresh round", () => {
    const state = stateWith([feedback("one", {
      resolution: "stale",
      status: "handed-off",
      handoff: { at: "2026-09-08T01:00:00.000Z", headOid: "old-head" },
    })])
    const next = reduceReviewState(state, {
      type: "feedback/reanchor",
      id: "one",
      anchor: { ...anchor },
      updatedAt: "2026-09-08T02:00:00.000Z",
    })
    expect(next.feedback[0]?.status).toBe("open")
    expect(next.feedback[0]).not.toHaveProperty("handoff")
    expect(next.feedback[0]?.resolution).toBe("active")
  })

  test("re-handing off keeps the original checkpoint, so the verdict keeps its baseline", () => {
    const already = feedback("one", {
      status: "handed-off",
      handoff: { at: "2026-09-08T01:00:00.000Z", headOid: "first" },
    })
    const next = reduceReviewState(stateWith([already]), {
      type: "feedback/handoff",
      items: [{ id: "one" }],
      at: "2026-09-08T09:00:00.000Z",
      headOid: "second",
    })
    expect(next.feedback[0]!.handoff?.headOid).toBe("first")
  })

  test("a resolved objection is not dragged back into a handoff", () => {
    const state = stateWith([feedback("one", { status: "resolved" })])
    const next = reduceReviewState(state, {
      type: "feedback/handoff",
      items: [{ id: "one" }],
      at: "t",
      headOid: "h1",
    })
    expect(next).toBe(state)
  })

  test("handing off nothing, or an id that is not there, changes nothing", () => {
    const state = stateWith([feedback("one")])
    expect(reduceReviewState(state, { type: "feedback/handoff", items: [], at: "t", headOid: "h1" })).toBe(state)
    expect(reduceReviewState(state, { type: "feedback/handoff", items: [{ id: "ghost" }], at: "t", headOid: "h1" })).toBe(state)
  })

  test("resolving is terminal and idempotent", () => {
    const state = stateWith([feedback("one", { status: "handed-off" })])
    const next = reduceReviewState(state, { type: "feedback/resolve", id: "one", at: "2026-09-08T02:00:00.000Z" })
    expect(next.feedback[0]!.status).toBe("resolved")
    expect(next.feedback[0]!.updatedAt).toBe("2026-09-08T02:00:00.000Z")
    expect(reduceReviewState(next, { type: "feedback/resolve", id: "one", at: "later" })).toBe(next)
    expect(reduceReviewState(next, { type: "feedback/resolve", id: "ghost", at: "later" })).toBe(next)
  })
})

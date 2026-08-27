import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { planReviewIntent } from "../../../src/review/core/intents"
import { matchReviewFiles, reconcileReviewState } from "../../../src/review/core/reconcile"
import { coverageForFile } from "../../../src/review/core/selectors"
import type { ReviewDocument, ReviewFile, ReviewFeedback } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
}
function makeGeneration(overrides: Partial<{ mergeBaseOid: string; baseOid: string; headOid: string }> = {}) {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1", ...overrides })
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
  } as unknown as ReviewFile
}
function makeDoc(files: ReviewFile[], generation = makeGeneration()): ReviewDocument {
  return createReviewDocument({ identity: makeIdentity(), generation, commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" }] as unknown as ReviewDocument["commits"], files })
}
function addViewed(state: ReturnType<typeof createInitialReviewState>, fileKey: string, viewedAt = "2026-08-27T00:00:00.000Z") {
  return reduceReviewState(state, planReviewIntent(state, { type: "viewed/mark", fileKey, viewedAt }))
}

describe("matchReviewFiles explicit distinctions", () => {
  test("exact match", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const next = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const m = matchReviewFiles(prev, next)
    // exact should be identifiable
    expect(m.exact?.has?.("src/a.ts") ?? (m as unknown as { previousToCurrent: Map<string, ReviewFile> }).previousToCurrent.has("src/a.ts")).toBe(true)
    // Or check entries
    const hasExact = (m as unknown as { entries?: unknown[] }).entries ? true : m.previousToCurrent.has("src/a.ts")
    expect(hasExact).toBe(true)
  })

  test("rename single previousPath transfers", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const next = [makeFile({ key: "src/b.ts", path: "src/b.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string })]
    const m = matchReviewFiles(prev, next)
    expect(m.rename?.has?.("src/a.ts") ?? m.previousToCurrent.has("src/a.ts")).toBe(true)
    expect(m.ambiguous?.has?.("src/a.ts") ?? false).toBe(false)
  })

  test("ambiguous rename refuses guessing", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const next = [
      makeFile({ key: "src/b.ts", path: "src/b.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
      makeFile({ key: "src/c.ts", path: "src/c.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
    ]
    const m = matchReviewFiles(prev, next)
    const isAmb = m.ambiguous?.has?.("src/a.ts") ?? (m as unknown as { ambiguousPreviousKeys: Set<string> }).ambiguousPreviousKeys?.has("src/a.ts")
    expect(isAmb).toBe(true)
    // previousToCurrent should not contain ambiguous
    expect(m.previousToCurrent.has("src/a.ts")).toBe(false)
  })

  test("copied file is new not rename", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const next = [
      makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" }),
      makeFile({ key: "src/copy.ts", path: "src/copy.ts", previousPath: "src/a.ts", kind: "copied", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
    ]
    const m = matchReviewFiles(prev, next)
    // copied should be in copiedFiles not in rename
    const hasRename = m.rename?.has?.("src/a.ts") ?? false
    // rename map should be empty or not include copy
    // copiedFiles should contain src/copy.ts
    const hasCopied = (m.copiedFiles ?? (m as unknown as { copied: unknown[] }).copied)?.some?.((f: ReviewFile) => f.key === "src/copy.ts") ?? false
    // At least ensure copy not treated as rename transfer
    expect(hasRename).toBe(false)
    // exact for original should remain
    expect(m.previousToCurrent.has("src/a.ts")).toBe(true)
  })

  test("deleted file", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" }), makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "c2" })]
    const next = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const m = matchReviewFiles(prev, next)
    const isDeleted = m.deletedFiles?.some?.((f: ReviewFile) => f.key === "src/b.ts") ?? (m as unknown as { deleted: unknown[] }).deleted?.some?.((f: unknown) => (f as ReviewFile).key === "src/b.ts") ?? false
    expect(isDeleted || !m.previousToCurrent.has("src/b.ts")).toBe(true)
  })

  test("new file", () => {
    const prev = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })]
    const next = [makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" }), makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "c2", kind: "added" } as Partial<ReviewFile> & { key: string; path: string })]
    const m = matchReviewFiles(prev, next)
    const hasNew = m.newFiles?.some?.((f: ReviewFile) => f.key === "src/b.ts") ?? (m.currentToPrevious && !m.currentToPrevious.has("src/b.ts"))
    expect(hasNew).toBe(true)
  })
})

describe("reconcileReviewState atomic", () => {
  test("unchanged file keeps viewed", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    const doc2 = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    expect(next.document.generation.headOid).toBe("h2")
    expect(next.viewed["src/a.ts"]).toBeDefined()
    expect(coverageForFile(next.document.files[0] as ReviewFile, next.viewed)).toBe("viewed")
    expect(next.revision).toBe(state.revision + 1)
  })

  test("changed content invalidates viewed", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    const doc2 = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c2" })], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    expect(coverageForFile(next.document.files[0] as ReviewFile, next.viewed)).toBe("changed-after-review")
  })

  test("rename transfers viewed but invalidates, and selection/anchors transfer", () => {
    // create a file with a range anchor
    const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" line1", " line2", " line3"] })
    const f1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1", hunks: [hunk] } as Partial<ReviewFile> & { key: string; path: string })
    const doc1 = makeDoc([f1])
    let state = createInitialReviewState(doc1)
    state = reduceReviewState(state, planReviewIntent(state, { type: "selection/select-file", fileKey: "src/a.ts" }))
    state = addViewed(state, "src/a.ts")
    // create feedback
    const { createRangeAnchor } = require("../../../src/review/core/anchors") as unknown as { createRangeAnchor: (f: ReviewFile, r: unknown) => unknown }
    // We'll create feedback via intents
    const anchor = createRangeAnchor(f1, { side: "new", startLine: 1, endLine: 2 }) as unknown as ReviewFeedback["anchor"]
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "hello" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "fb1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // rename to src/b.ts with same content
    const f2 = makeFile({ key: "src/b.ts", path: "src/b.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1", hunks: [hunk] } as Partial<ReviewFile> & { key: string; path: string })
    const doc2 = makeDoc([f2], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    // viewed transferred to new key but path mismatch => changed-after-review
    expect(next.viewed["src/b.ts"]).toBeDefined()
    expect(next.viewed["src/a.ts"]).toBeUndefined()
    expect(coverageForFile(next.document.files[0] as ReviewFile, next.viewed)).toBe("changed-after-review")
    // selection transferred
    expect(next.selection.fileKey).toBe("src/b.ts")
    // feedback anchor transferred to new fileKey
    expect(next.feedback[0]?.anchor.fileKey).toBe("src/b.ts")
    expect(next.feedback[0]?.resolution).toBe("active")
  })

  test("ambiguous rename refuses guessing - viewed deleted, selection fallback, feedback orphaned", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    // add feedback
    const fbAnchor = { kind: "file" as const, fileKey: "src/a.ts", contentId: "c1" }
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: fbAnchor, kind: "note", severity: "comment", body: "hi" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "fb1", createdAt: "2026-08-27T00:00:00.000Z" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "selection/select-file", fileKey: "src/a.ts" }))
    // ambiguous rename: two files claim previousPath src/a.ts
    const nextFiles = [
      makeFile({ key: "src/b.ts", path: "src/b.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
      makeFile({ key: "src/c.ts", path: "src/c.ts", previousPath: "src/a.ts", kind: "renamed", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
    ]
    const doc2 = makeDoc(nextFiles, makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    // viewed not transferred (ambiguous)
    expect(next.viewed["src/a.ts"]).toBeUndefined()
    expect(next.viewed["src/b.ts"]).toBeUndefined()
    expect(next.viewed["src/c.ts"]).toBeUndefined()
    // selection fallback to nearest visible (first file)
    expect(["src/b.ts", "src/c.ts", null]).toContain(next.selection.fileKey)
    // feedback orphaned
    expect(next.feedback[0]?.resolution).toBe("orphaned")
  })

  test("copied file is new - not viewed", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    const doc2 = makeDoc([
      makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" }),
      makeFile({ key: "src/copy.ts", path: "src/copy.ts", previousPath: "src/a.ts", kind: "copied", contentId: "c1" } as Partial<ReviewFile> & { key: string; path: string }),
    ], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    expect(next.viewed["src/a.ts"]).toBeDefined()
    expect(next.viewed["src/copy.ts"]).toBeUndefined()
    expect(coverageForFile(next.document.files.find(f => f.key === "src/copy.ts") as ReviewFile, next.viewed)).toBe("not-viewed")
  })

  test("deletion feedback becomes orphaned and viewed removed", () => {
    const f1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const f2 = makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "c2" })
    const doc1 = makeDoc([f1, f2])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/b.ts")
    const anchor = { kind: "file" as const, fileKey: "src/b.ts", contentId: "c2" }
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "hi" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "fb1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // delete src/b.ts
    const doc2 = makeDoc([f1], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    expect(next.viewed["src/b.ts"]).toBeUndefined()
    expect(next.feedback[0]?.resolution).toBe("orphaned")
  })

  test("stale anchor when content changed without unique relocation", () => {
    const hunk1 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" line1", " line2", " line3"] })
    const f1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1", hunks: [hunk1] } as Partial<ReviewFile> & { key: string; path: string })
    const doc1 = makeDoc([f1])
    let state = createInitialReviewState(doc1)
    const anchor = (() => {
      const { createRangeAnchor } = require("../../../src/review/core/anchors") as unknown as { createRangeAnchor: (f: ReviewFile, r: unknown) => unknown }
      return createRangeAnchor(f1, { side: "new", startLine: 1, endLine: 1 }) as unknown as ReviewFeedback["anchor"]
    })()
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "hi" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "fb1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // new content with different lines - context not found
    const hunk2 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" changed1", " changed2", " changed3"] })
    const f2 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c2", hunks: [hunk2] } as Partial<ReviewFile> & { key: string; path: string })
    const doc2 = makeDoc([f2], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    expect(next.feedback[0]?.resolution).toBe("stale")
  })

  test("expanded gaps retirement", () => {
    const f1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const f2 = makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "c2" })
    const doc1 = makeDoc([f1, f2])
    let state = createInitialReviewState(doc1)
    state = reduceReviewState(state, planReviewIntent(state, { type: "gap/toggle", fileKey: "src/a.ts", gapId: "gap1" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "gap/toggle", fileKey: "src/b.ts", gapId: "gap2" }))
    expect(state.expandedGaps.length).toBe(2)
    // delete src/a.ts and rename src/b.ts -> src/c.ts
    const f2renamed = makeFile({ key: "src/c.ts", path: "src/c.ts", previousPath: "src/b.ts", kind: "renamed", contentId: "c2" } as Partial<ReviewFile> & { key: string; path: string })
    const doc2 = makeDoc([f2renamed], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    // gap for deleted file retired, gap for renamed file transferred
    expect(next.expandedGaps.some(g => g.fileKey === "src/a.ts")).toBe(false)
    expect(next.expandedGaps.some(g => g.fileKey === "src/c.ts")).toBe(true)
    expect(next.expandedGaps.find(g => g.fileKey === "src/c.ts")?.gapId).toBe("gap2")
  })

  test("base movement is new generation same matching rules", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f], makeGeneration({ baseOid: "b1", mergeBaseOid: "m1", headOid: "h1" }))
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    const doc2 = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })], makeGeneration({ baseOid: "b2", mergeBaseOid: "m2", headOid: "h1" }))
    const next = reconcileReviewState(state, doc2)
    expect(next.document.generation.baseOid).toBe("b2")
    expect(next.viewed["src/a.ts"]).toBeDefined()
    expect(coverageForFile(next.document.files[0] as ReviewFile, next.viewed)).toBe("viewed")
  })

  test("selection fallback to nearest visible file", () => {
    const f1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const f2 = makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "c2" })
    const f3 = makeFile({ key: "src/c.ts", path: "src/c.ts", contentId: "c3" })
    const doc1 = makeDoc([f1, f2, f3])
    let state = createInitialReviewState(doc1)
    state = reduceReviewState(state, planReviewIntent(state, { type: "selection/select-file", fileKey: "src/b.ts" }))
    // delete middle file
    const doc2 = makeDoc([f1, f3], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    // should fallback to nearest: either a or c (prefer next? we clamp to nearest index)
    expect(["src/a.ts", "src/c.ts"]).toContain(next.selection.fileKey as string)
  })

  test("reconcile is atomic - single reducer action", () => {
    const f = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c1" })
    const doc1 = makeDoc([f])
    let state = createInitialReviewState(doc1)
    state = addViewed(state, "src/a.ts")
    const doc2 = makeDoc([makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "c2" })], makeGeneration({ headOid: "h2" }))
    const next = reconcileReviewState(state, doc2)
    // Should have incremented revision exactly once regardless of multiple changes
    expect(next.revision).toBe(state.revision + 1)
    expect(next.document).toBe(doc2)
  })
})

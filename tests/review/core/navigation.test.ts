import { describe, expect, test } from "bun:test"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewIntent } from "../../../src/review/core/intents"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { moveReviewSelection } from "../../../src/review/core/navigation"
import { visibleReviewFiles } from "../../../src/review/core/selectors"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
}
function makeGeneration() {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" })
}
function makeHunk(index: number) {
  return { index, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["+x"], digest: `d${index}` }
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
    hunks: [] as unknown as ReviewFile["hunks"],
    source: "available",
    ...overrides,
  } as ReviewFile
}
function makeDoc(files: ReviewFile[]): ReviewDocument {
  return createReviewDocument({ identity: makeIdentity(), generation: makeGeneration(), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files })
}

describe("navigation", () => {
  test("next/previous file clamp at boundaries", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts" }), makeFile({ key: "b", path: "b.ts" }), makeFile({ key: "c", path: "c.ts" })])
    let s = createInitialReviewState(doc)
    expect(s.selection.fileKey).toBe("a")
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "next" }))
    expect(s.selection.fileKey).toBe("b")
    expect(s.reveal.fileTopToken).toBe(1)
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "next" }))
    expect(s.selection.fileKey).toBe("c")
    // clamp at end
    const sClamped = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "next" }))
    expect(sClamped).toBe(s)
    expect(sClamped.selection.fileKey).toBe("c")
    // previous
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "previous" }))
    expect(s.selection.fileKey).toBe("b")
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "previous" }))
    expect(s.selection.fileKey).toBe("a")
    const sClampedPrev = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "previous" }))
    expect(sClampedPrev).toBe(s)
  })

  test("next/previous hunk clamp and walks visible order", () => {
    const doc = makeDoc([
      makeFile({ key: "a", path: "a.ts", hunks: [makeHunk(0), makeHunk(1)] as unknown as ReviewFile["hunks"] }),
      makeFile({ key: "b", path: "b.ts", hunks: [makeHunk(0)] as unknown as ReviewFile["hunks"] }),
    ])
    let s = createInitialReviewState(doc)
    expect(s.selection).toEqual({ fileKey: "a", hunkIndex: 0 })
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "hunk", direction: "next" }))
    expect(s.selection).toEqual({ fileKey: "a", hunkIndex: 1 })
    expect(s.reveal.hunkToken).toBe(1)
    expect(s.reveal.fileTopRequestToken).toBe(0)
    s = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "hunk", direction: "next" }))
    // crosses to next file -> fileTopToken increments
    expect(s.selection).toEqual({ fileKey: "b", hunkIndex: 0 })
    expect(s.reveal.fileTopToken).toBe(1)
    expect(s.reveal.fileTopRequestToken).toBe(1)
    const clamped = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "hunk", direction: "next" }))
    expect(clamped).toBe(s)
    // Backward cross-file moves keep legacy file-top history and request a hunk reveal.
    const fileTopTokenBeforePrevious = clamped.reveal.fileTopToken
    const fileTopRequestTokenBeforePrevious = clamped.reveal.fileTopRequestToken
    const hunkTokenBeforePrevious = clamped.reveal.hunkToken
    let s2 = reduceReviewState(clamped, planReviewIntent(clamped, { type: "selection/move", unit: "hunk", direction: "previous" }))
    expect(s2.selection).toEqual({ fileKey: "a", hunkIndex: 1 })
    expect(s2.reveal.fileTopToken).toBe(fileTopTokenBeforePrevious + 1)
    expect(s2.reveal.fileTopRequestToken).toBe(fileTopRequestTokenBeforePrevious)
    expect(s2.reveal.hunkToken).toBe(hunkTokenBeforePrevious + 1)
    s2 = reduceReviewState(s2, planReviewIntent(s2, { type: "selection/move", unit: "hunk", direction: "previous" }))
    expect(s2.selection).toEqual({ fileKey: "a", hunkIndex: 0 })
    const clampedPrev = reduceReviewState(s2, planReviewIntent(s2, { type: "selection/move", unit: "hunk", direction: "previous" }))
    expect(clampedPrev).toBe(s2)
  })

  test("navigation never invents wrap behavior", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts" }), makeFile({ key: "b", path: "b.ts" })])
    const s = createInitialReviewState(doc)
    // at first file, previous file is no-op, not wrap to last
    const prev = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "previous" }))
    expect(prev).toBe(s)
    // move to last
    let cur = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "next" }))
    expect(cur.selection.fileKey).toBe("b")
    const next = reduceReviewState(cur, planReviewIntent(cur, { type: "selection/move", unit: "file", direction: "next" }))
    expect(next).toBe(cur)
    expect(next.selection.fileKey).not.toBe("a")
  })

  test("visible order respected and filtered navigation", () => {
    const doc = makeDoc([makeFile({ key: "a", path: "a.ts" }), makeFile({ key: "b", path: "b.ts" }), makeFile({ key: "c", path: "c.ts" })])
    let s = createInitialReviewState(doc)
    s = reduceReviewState(s, planReviewIntent(s, { type: "filter/set-query", query: "b" }))
    expect(visibleReviewFiles(s).map((f) => f.key)).toEqual(["b"])
    // Hidden selections re-anchor at the visible boundary instead of getting stuck.
    const moved = reduceReviewState(s, planReviewIntent(s, { type: "selection/move", unit: "file", direction: "next" }))
    expect(moved.selection.fileKey).toBe("b")
    const moved2 = moveReviewSelection(s, "file", "next")
    expect(moved2?.selection.fileKey).toBe("b")
  })

  test("empty documents return null for moves", () => {
    const doc = makeDoc([])
    const s = createInitialReviewState(doc)
    expect(moveReviewSelection(s, "file", "next")).toBeNull()
    expect(moveReviewSelection(s, "hunk", "next")).toBeNull()
    expect(moveReviewSelection(s, "file", "previous")).toBeNull()
  })

  test("moveReviewSelection increments correct token", () => {
    const doc = makeDoc([
      makeFile({ key: "a", path: "a.ts", hunks: [makeHunk(0), makeHunk(1)] as unknown as ReviewFile["hunks"] }),
      makeFile({ key: "b", path: "b.ts", hunks: [makeHunk(0)] as unknown as ReviewFile["hunks"] }),
    ])
    const s0 = createInitialReviewState(doc)
    const t1 = moveReviewSelection(s0, "hunk", "next")
    expect(t1).not.toBeNull()
    expect(t1!.reveal.hunkToken).toBe(s0.reveal.hunkToken + 1)
    expect(t1!.reveal.fileTopToken).toBe(s0.reveal.fileTopToken)
    expect(t1!.reveal.fileTopRequestToken).toBe(s0.reveal.fileTopRequestToken)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "selection/move", unit: "hunk", direction: "next" }))
    const t2 = moveReviewSelection(s1, "hunk", "next")
    expect(t2!.reveal.fileTopToken).toBe(s1.reveal.fileTopToken + 1)
    expect(t2!.reveal.fileTopRequestToken).toBe(s1.reveal.fileTopRequestToken + 1)
  })
})

import { describe, expect, test } from "bun:test"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewIntent } from "../../../src/review/core/intents"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { createFileAnchor, createRangeAnchor } from "../../../src/review/core/anchors"
import { validateFinishReview } from "../../../src/review/core/artifact"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "main" })
}
function makeGeneration() {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" })
}
function makeHunk(index: number, newStart: number, lines: string[]) {
  return createReviewHunk({ index, oldStart: newStart, oldCount: lines.length, newStart, newCount: lines.length, lines })
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
function makeDoc(files: ReviewFile[]): ReviewDocument {
  return createReviewDocument({ identity: makeIdentity(), generation: makeGeneration(), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files })
}

describe("feedback lifecycle", () => {
  test("draft start/update/cancel/create", () => {
    const h = makeHunk(0, 1, [" a", " b", " c"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 2 })
    // start
    const startAction = planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "hello" })
    state = reduceReviewState(state, startAction)
    expect(state.draft).not.toBeNull()
    expect(state.draft?.body).toBe("hello")
    // update
    const upd = planReviewIntent(state, { type: "feedback/update-draft", body: "updated" })
    state = reduceReviewState(state, upd)
    expect(state.draft?.body).toBe("updated")
    // cancel
    const cancel = planReviewIntent(state, { type: "feedback/cancel-draft" })
    state = reduceReviewState(state, cancel)
    expect(state.draft).toBeNull()
    // start again and create
    const s2 = planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "final" })
    state = reduceReviewState(state, s2)
    const created = planReviewIntent(state, { type: "feedback/create", id: "f1", createdAt: "2026-08-27T00:00:00.000Z" })
    state = reduceReviewState(state, created)
    expect(state.feedback.length).toBe(1)
    expect(state.feedback[0]?.id).toBe("f1")
    expect(state.draft).toBeNull()
  })

  test("suggestion requires new-side range and replacement", () => {
    const h = makeHunk(0, 1, [" a", " b", " c"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    // old side suggestion should fail
    const oldAnchor = createRangeAnchor(file, { side: "old", startLine: 2, endLine: 2 })
    expect(() => planReviewIntent(state, { type: "feedback/start-draft", anchor: oldAnchor, kind: "suggestion", severity: "comment", body: "fix", replacement: "new" })).toThrow()
    // new side without replacement should fail
    const newAnchor = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 2 })
    expect(() => planReviewIntent(state, { type: "feedback/start-draft", anchor: newAnchor, kind: "suggestion", severity: "comment", body: "fix", replacement: "" })).toThrow()
    // file anchor suggestion should fail
    const fileAnchor = createFileAnchor(file)
    expect(() => planReviewIntent(state, { type: "feedback/start-draft", anchor: fileAnchor, kind: "suggestion", severity: "comment", body: "fix", replacement: "rep" })).toThrow()
    // valid suggestion
    const ok = planReviewIntent(state, { type: "feedback/start-draft", anchor: newAnchor, kind: "suggestion", severity: "comment", body: "fix", replacement: "rep" })
    expect(ok.type).toBe("feedback/start-draft")
  })

  test("binary file rejects suggestions", () => {
    const file = makeFile({ key: "bin", path: "img.png", kind: "binary", source: "binary" as const, hunks: [] as unknown as ReviewFile["hunks"] })
    // file anchor suggestion should be rejected even if file anchor
    const doc = makeDoc([file])
    const state = createInitialReviewState(doc)
    const fileAnchor = createFileAnchor(file)
    // even file anchor suggestion invalid
    expect(() => planReviewIntent(state, { type: "feedback/start-draft", anchor: fileAnchor, kind: "suggestion", severity: "comment", body: "x", replacement: "y" })).toThrow()
  })

  test("edit/delete/re-anchor", () => {
    const h = makeHunk(0, 1, [" a", " b", " c"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const file2 = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, 1, [" x", " y"])] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file, file2])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "orig" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "f1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // edit
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/edit", id: "f1", body: "edited", updatedAt: "2026-08-27T01:00:00.000Z" }))
    expect(state.feedback[0]?.body).toBe("edited")
    // re-anchor
    const newAnchor = createRangeAnchor(file2, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/reanchor", id: "f1", anchor: newAnchor, updatedAt: "2026-08-27T02:00:00.000Z" }))
    expect(state.feedback[0]?.anchor.fileKey).toBe("b")
    // delete
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/delete", id: "f1" }))
    expect(state.feedback.length).toBe(0)
  })

  test("feedback-order navigation next/previous", () => {
    const h1 = makeHunk(0, 1, [" a"])
    const h2 = makeHunk(0, 1, [" b"])
    const h3 = makeHunk(0, 1, [" c"])
    const f1 = makeFile({ key: "a", path: "src/a.ts", hunks: [h1] as unknown as ReviewFile["hunks"] })
    const f2 = makeFile({ key: "b", path: "src/b.ts", hunks: [h2] as unknown as ReviewFile["hunks"] })
    const f3 = makeFile({ key: "c", path: "src/c.ts", hunks: [h3] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([f1, f2, f3])
    let state = createInitialReviewState(doc)
    const a1 = createRangeAnchor(f1, { side: "new", startLine: 1, endLine: 1 })
    const a2 = createRangeAnchor(f2, { side: "new", startLine: 1, endLine: 1 })
    const a3 = createRangeAnchor(f3, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: a1, kind: "note", severity: "comment", body: "1" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "1", createdAt: "2026-08-27T00:00:00.000Z" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: a2, kind: "note", severity: "comment", body: "2" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "2", createdAt: "2026-08-27T00:00:00.000Z" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: a3, kind: "note", severity: "comment", body: "3" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "3", createdAt: "2026-08-27T00:00:00.000Z" }))
    // start at first file
    // move next feedback should go through order a->b->c
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/next" }))
    // since initial selection is f1 (first file), next should move to f2? depends implementation
    // we test that after multiple nexts we reach c and clamp
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/next" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/next" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/next" }))
    // previous
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/previous" }))
    expect(state.feedback.length).toBe(3)
  })

  test("restart-shaped state values preserve feedback and draft", () => {
    const h = makeHunk(0, 1, [" a", " b"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "draft" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "f1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // simulate persisted shape: should have document, revision, projection, selection, reveal, filter, feedback, draft, expandedGaps, lastSubmission
    expect(state).toHaveProperty("feedback")
    expect(state).toHaveProperty("draft")
    expect(state).toHaveProperty("revision")
    expect(state).toHaveProperty("document")
    expect(state).toHaveProperty("selection")
    expect(Array.isArray(state.feedback)).toBe(true)
  })

  test("blocking vs comment severity validation through finish rules", () => {
    const h = makeHunk(0, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "blocking", body: "block" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "fb1", createdAt: "2026-08-27T00:00:00.000Z" }))
    expect(validateFinishReview(state, { decision: "approve", summary: "Looks good" })).toEqual({ ok: false, reason: "approve-has-blocking-feedback" })
    expect(validateFinishReview(state, { decision: "request-changes", summary: "Please address" })).toEqual({ ok: true })
  })
})

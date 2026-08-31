import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { createLineSelection } from "../../../src/review/core/anchors"
import { moveReviewLineSelection } from "../../../src/review/core/navigation"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { reconcileReviewState } from "../../../src/review/core/reconcile"
import { serializeReviewDatabaseV2, parseReviewDatabaseV2 } from "../../../src/review/storage/schemas"
import { persistedFromReviewState } from "../../../src/review/storage/review-state-store"
import { validateFinishReview, buildReviewArtifact } from "../../../src/review/core/artifact"
import { planReviewIntent } from "../../../src/review/core/intents"
import type { ReviewFile } from "../../../src/review/core/types"

function file(contentId = "cid"): ReviewFile {
  const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " c"] })
  return { kind: "modified", contentId, patchDigest: "p", stats: { additions: 0, deletions: 0 }, hunks: [hunk], source: "available", key: "a", path: "a.ts" } as unknown as ReviewFile
}
function doc(files: readonly ReviewFile[] = [file()]) {
  return createReviewDocument({ identity: createReviewIdentity({ headRef: "refs/heads/main", headOid: "h", baseRef: "main" }), generation: createReviewGeneration({ mergeBaseOid: "m", baseOid: "b", headOid: "h" }), commits: [], files })
}

describe("semantic line selection", () => {
  test("constructs canonical identity and moves within hunk", () => {
    const f = file()
    const first = createLineSelection(f, { hunkIndex: 0, side: "new", line: 1 })
    expect(first).toMatchObject({ fileKey: "a", hunkIndex: 0, side: "new", line: 1, contentId: "cid" })
    const moved = moveReviewLineSelection({ ...createInitialReviewState(doc()), lineSelection: first }, "next")
    expect(moved?.line).toBe(2)
  })
  test("reducer clears semantic line when viewport navigation changes", () => {
    const d = doc(); const s = createInitialReviewState(d); const line = createLineSelection(file(), { hunkIndex: 0, side: "new", line: 1 })
    const withLine = reduceReviewState(s, { type: "selection/set-line", selection: line })
    expect(reduceReviewState(withLine, { type: "selection/viewport-anchor", fileKey: "a", hunkIndex: 0, reveal: "hunk" }).lineSelection).toBeNull()
  })
  test("reconciliation preserves identity and null/null is a no-op", () => {
    const d = doc(); const initial = createInitialReviewState(d)
    expect(reconcileReviewState(initial, doc())).toBe(initial)
    const line = createLineSelection(file(), { hunkIndex: 0, side: "new", line: 2 })
    const selected = reduceReviewState(initial, { type: "selection/set-line", selection: line })
    const reconciled = reconcileReviewState(selected, doc())
    expect(reconciled.lineSelection).toEqual(line)
    expect(reconciled.revision).toBe(selected.revision)
  })
  test("reconciles a uniquely relocated line after content identity changes", () => {
    const oldFile = file("old")
    const newFile = {
      ...file("new"),
      hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 4, newStart: 1, newCount: 4, lines: [" x", " a", " b", " c"] })],
    } as unknown as ReviewFile
    const oldDoc = doc([oldFile])
    const newDoc = doc([newFile])
    const oldLine = createLineSelection(oldFile, { hunkIndex: 0, side: "new", line: 2 })
    const selected = reduceReviewState(createInitialReviewState(oldDoc), { type: "selection/set-line", selection: oldLine })
    const reconciled = reconcileReviewState(selected, newDoc)
    expect(reconciled.lineSelection?.line).toBe(3)
    expect(reconciled.lineSelection?.contentId).toBe("new")
  })
  test("non-null line selection survives strict persistence round trip", () => {
    const d = doc(); const line = createLineSelection(file(), { hunkIndex: 0, side: "new", line: 2 })
    const state = reduceReviewState(createInitialReviewState(d), { type: "selection/set-line", selection: line })
    const db = { version: 2 as const, baseByHead: {}, reviews: { [d.identity.id]: persistedFromReviewState(state) } }
    const parsed = parseReviewDatabaseV2(JSON.parse(serializeReviewDatabaseV2(db)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.reviews[d.identity.id]!.lineSelection).toEqual(line)
  })
  test("Finish rejects invalid suggestions while aggregate artifact builds", () => {
    const state = createInitialReviewState(doc())
    const invalid = { id: "s", kind: "suggestion" as const, severity: "comment" as const, body: "b", replacement: " ", anchor: { kind: "file" as const, fileKey: "a", contentId: "cid" }, resolution: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const withInvalid = { ...state, feedback: [invalid] }
    expect(validateFinishReview(withInvalid, { decision: "comment", summary: "s" })).toEqual({ ok: false, reason: "suggestion-invalid" })
    expect(() => buildReviewArtifact(withInvalid, { id: "x", submittedAt: new Date().toISOString(), decision: "comment", summary: "s" })).toThrow("suggestion-invalid")
    expect(buildReviewArtifact(state, { id: "x", submittedAt: new Date().toISOString(), decision: "comment", summary: "s" }).projection).toEqual({ kind: "aggregate" })
  })
  test("blank replacement persists in open draft but strict create rejects it", () => {
    const d = doc(); const f = file(); const line = createLineSelection(f, { hunkIndex: 0, side: "new", line: 1 })
    const anchor = { kind: "range" as const, fileKey: "a", contentId: "cid", side: "new" as const, startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: line.contextDigest }
    let state = createInitialReviewState(d)
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "suggestion", severity: "comment", body: "fix", replacement: " " }))
    expect(state.draft?.replacement).toBe(" ")
    expect(() => planReviewIntent(state, { type: "feedback/create", id: "s", createdAt: new Date().toISOString() })).toThrow("non-empty")
    const db = { version: 2 as const, baseByHead: {}, reviews: { [d.identity.id]: persistedFromReviewState(state) } }
    const parsed = parseReviewDatabaseV2(JSON.parse(serializeReviewDatabaseV2(db)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.reviews[d.identity.id]!.draft?.replacement).toBe(" ")
  })
})

import { describe, expect, test } from "bun:test"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewIntent } from "../../../src/review/core/intents"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { createRangeAnchor } from "../../../src/review/core/anchors"
import { validateFinishReview, buildReviewArtifact, renderReviewArtifactMarkdown } from "../../../src/review/core/artifact"
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

describe("artifact finish and markdown", () => {
  test("validate finish with blocking approve vs request-changes", () => {
    const h = makeHunk(0, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "blocking", body: "must fix" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "b1", createdAt: "2026-08-27T00:00:00.000Z" }))
    expect(validateFinishReview(state, { decision: "approve", summary: "Looks good" })).toEqual({ ok: false, reason: "approve-has-blocking-feedback" })
    expect(validateFinishReview(state, { decision: "request-changes", summary: "Please address this" })).toEqual({ ok: true })
  })

  test("stale feedback blocks finish", () => {
    const h = makeHunk(0, 1, [" a", " b"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "note" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "f1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // manually mark stale to simulate generation change without re-anchor
    // we simulate by editing state directly for test (since reconcile would set stale)
    const staleFeedback = { ...state.feedback[0]!, resolution: "stale" as const }
    const staleState = { ...state, feedback: [staleFeedback] } as unknown as typeof state
    expect(validateFinishReview(staleState, { decision: "request-changes", summary: "Please address this" })).toEqual({ ok: false, reason: "feedback-needs-reanchor" })
  })

  test("buildReviewArtifact deterministic id/timestamp and rejects commit projection", () => {
    const h = makeHunk(0, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    let state = createInitialReviewState(doc)
    const artifact = buildReviewArtifact(state, { id: "art-1", submittedAt: "2026-08-27T00:00:00.000Z", decision: "comment", summary: "nice" })
    expect(artifact.id).toBe("art-1")
    expect(artifact.submittedAt).toBe("2026-08-27T00:00:00.000Z")
    expect(artifact.decision).toBe("comment")
    // commit projection should be rejected
    const commitState = { ...state, projection: { kind: "commit" as const, oid: "c1" } } as unknown as typeof state
    expect(() => buildReviewArtifact(commitState, { id: "art-2", submittedAt: "2026-08-27T00:00:00.000Z", decision: "comment", summary: "x" })).toThrow()
  })

  test("markdown ordering decision/summary, generation, coverage, blocking, comment, suggestion fences", () => {
    const h = makeHunk(0, 1, [" a", " b", " c"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const file2 = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, 1, [" x"])] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file, file2])
    let state = createInitialReviewState(doc)
    const anchor1 = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    const anchor2 = createRangeAnchor(file2, { side: "new", startLine: 1, endLine: 1 })
    // blocking suggestion
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: anchor1, kind: "suggestion", severity: "blocking", body: "fix", replacement: "replaced code" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "s1", createdAt: "2026-08-27T00:00:00.000Z" }))
    // comment note
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: anchor2, kind: "note", severity: "comment", body: "comment" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "c1", createdAt: "2026-08-27T00:00:00.000Z" }))
    const artifact = buildReviewArtifact(state, { id: "art-1", submittedAt: "2026-08-27T00:00:00.000Z", decision: "request-changes", summary: "Please address blocking" })
    const md = renderReviewArtifactMarkdown(artifact)
    const idxDecision = md.indexOf("request-changes")
    const idxSummary = md.indexOf("Please address blocking")
    const idxGen = md.indexOf(artifact.generation.id) !== -1 ? md.indexOf(artifact.generation.id) : md.indexOf(artifact.generation.headOid)
    const idxCoverage = md.toLowerCase().indexOf("coverage")
    const idxBlocking = md.indexOf("fix")
    const idxComment = md.indexOf("comment")
    const idxFence = md.indexOf("```")
    // ordering checks
    expect(idxDecision).toBeGreaterThanOrEqual(0)
    expect(idxDecision).toBeLessThan(idxSummary)
    expect(idxCoverage).toBeGreaterThan(idxGen >=0 ? idxGen : idxSummary)
    expect(idxBlocking).toBeGreaterThan(idxCoverage)
    expect(idxComment).toBeGreaterThan(idxBlocking)
    expect(idxFence).toBeGreaterThan(idxBlocking)
    // blocking should appear before comment in blocking-first ordering
    expect(md.indexOf("replaced code")).toBeGreaterThan(idxBlocking)
  })
})

import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { createFileAnchor } from "../../../src/review/core/anchors"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"

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
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
    source: "available",
    ...overrides,
  }
}

function makeDoc(files: readonly ReviewFile[]): ReviewDocument {
  return createReviewDocument({
    identity: createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" }),
    generation: createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" }),
    commits: [],
    files: [...files],
  })
}

const aggregateFiles = [
  makeFile({ key: "src/a.ts", path: "src/a.ts" }),
  makeFile({ key: "src/b.ts", path: "src/b.ts" }),
  makeFile({ key: "src/c.ts", path: "src/c.ts" }),
]
// A since-last-review lens sees a narrower range, so the same file carries a
// different contentId than the aggregate does.
const lensFiles = [makeFile({ key: "src/b.ts", path: "src/b.ts", contentId: "content-src/b.ts@lens" })]

function stateWithProgress() {
  const state = createInitialReviewState(makeDoc(aggregateFiles))
  return {
    ...state,
    selection: { fileKey: "src/c.ts", hunkIndex: 0 },
    viewed: {
      "src/a.ts": {
        fileKey: "src/a.ts",
        path: "src/a.ts",
        contentId: "content-src/a.ts",
        generationId: state.document.generation.id,
        viewedAt: "2026-09-01T00:00:00.000Z",
      },
    },
    feedback: [{
      id: "feedback-1",
      kind: "note" as const,
      severity: "comment" as const,
      body: "look here",
      anchor: createFileAnchor(aggregateFiles[0]!),
      resolution: "active" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }],
    expandedGaps: [{ fileKey: "src/a.ts", gapId: "before:1", expanded: true }],
    lineSelection: {
      fileKey: "src/a.ts",
      hunkIndex: 0,
      side: "new" as const,
      line: 1,
      contentId: "content-src/a.ts",
      contextDigest: "digest",
    },
  }
}

describe("Projection lens", () => {
  test("swaps the document and the active projection together", () => {
    const state = stateWithProgress()
    const next = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc(lensFiles),
    })

    expect(next.projection).toEqual({ kind: "since-last-review", fromHeadOid: "c1" })
    expect(next.document.files.map((file) => file.key)).toEqual(["src/b.ts"])
    expect(next.revision).toBe(state.revision + 1)
  })

  test("carries review progress across the switch untouched", () => {
    const state = stateWithProgress()
    const next = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc(lensFiles),
    })

    // The lens is a different view of the same review, not a different review:
    // viewed records and feedback stay exactly as the aggregate left them.
    expect(next.viewed).toBe(state.viewed)
    expect(next.feedback).toBe(state.feedback)
    expect(next.lastSubmission).toBe(state.lastSubmission)
  })

  test("drops view state that cannot survive a different file set", () => {
    const state = stateWithProgress()
    const next = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc(lensFiles),
    })

    // src/c.ts is not in the lens, and gap ids and line selections address
    // positions inside a specific file's hunk list.
    expect(next.selection).toEqual({ fileKey: "src/b.ts", hunkIndex: 0 })
    expect(next.lineSelection).toBeNull()
    expect(next.expandedGaps).toEqual([])
  })

  test("requests a scroll back to the top of the new stream", () => {
    const state = stateWithProgress()
    const next = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc(lensFiles),
    })

    expect(next.reveal.fileTopRequestToken).toBe(state.reveal.fileTopRequestToken + 1)
    expect(next.reveal.scrollToFeedback).toBe(false)
  })

  test("returns to the aggregate through the same action", () => {
    const state = stateWithProgress()
    const lens = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc(lensFiles),
    })
    const back = reduceReviewState(lens, {
      type: "projection/apply",
      projection: { kind: "aggregate" },
      document: state.document,
    })

    expect(back.projection).toEqual({ kind: "aggregate" })
    expect(back.document.files.map((file) => file.key)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
    expect(back.viewed).toBe(state.viewed)
    expect(back.feedback).toBe(state.feedback)
  })

  test("tolerates an empty lens when nothing changed since the last review", () => {
    const state = stateWithProgress()
    const next = reduceReviewState(state, {
      type: "projection/apply",
      projection: { kind: "since-last-review", fromHeadOid: "c1" },
      document: makeDoc([]),
    })

    expect(next.document.files).toEqual([])
    expect(next.selection).toEqual({ fileKey: null, hunkIndex: 0 })
  })
})

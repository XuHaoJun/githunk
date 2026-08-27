import { describe, expect, test } from "bun:test"
import { reviewFileRows } from "../../../src/ui/review-workspace/files-pane"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"
import type { ReviewState } from "../../../src/review/core/state"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFiles(): ReviewFile[] {
  return [
    {
      key: "src/payment.ts",
      path: "src/payment.ts",
      kind: "modified",
      oldBlobOid: "o1",
      newBlobOid: "n1",
      oldMode: "100644",
      newMode: "100644",
      contentId: "c-payment",
      patchDigest: "p1",
      stats: { additions: 10, deletions: 2 },
      hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
      source: "available",
    },
    {
      key: "src/validation.ts",
      path: "src/validation.ts",
      kind: "modified",
      oldBlobOid: "o2",
      newBlobOid: "n2",
      oldMode: "100644",
      newMode: "100644",
      contentId: "c-validation",
      patchDigest: "p2",
      stats: { additions: 5, deletions: 5 },
      hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-a", "+b"] })],
      source: "available",
    },
    {
      key: "src/types.ts",
      path: "src/types.ts",
      kind: "added",
      oldBlobOid: null,
      newBlobOid: "n3",
      oldMode: null,
      newMode: "100644",
      contentId: "c-types",
      patchDigest: "p3",
      stats: { additions: 20, deletions: 0 },
      hunks: [createReviewHunk({ index: 0, oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: ["+new"] })],
      source: "available",
    },
    {
      key: "src/tests.ts",
      path: "src/tests.ts",
      kind: "modified",
      oldBlobOid: "o4",
      newBlobOid: "n4",
      oldMode: "100644",
      newMode: "100644",
      contentId: "c-tests",
      patchDigest: "p4",
      stats: { additions: 0, deletions: 0 },
      hunks: [],
      source: "available",
    },
  ]
}

function makeState(overrides?: Partial<ReviewState> & { files?: ReviewFile[] }): ReviewState {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const files = overrides?.files ?? makeFiles()
  const doc = createReviewDocument({
    identity,
    generation,
    commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }],
    files,
  })
  const base: ReviewState = {
    document: doc,
    revision: 0,
    projection: { kind: "aggregate" },
    selection: { fileKey: files[0]?.key ?? null, hunkIndex: 0 },
    reveal: { fileTopToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    viewed: {},
    feedback: [],
    draft: null,
    expandedGaps: [],
    lastSubmission: null,
  }
  if (!overrides) return base
  // Merge overrides without duplicate document key
  const { files: _f, document: _doc, ...rest } = overrides as unknown as Record<string, unknown>
  const docOverride = (overrides as { document?: ReviewState["document"] }).document
  return {
    ...base,
    ...rest,
    document: docOverride ?? doc,
  } as ReviewState
}

describe("reviewFileRows — markers", () => {
  test("○ not viewed, ◐ reviewing, ● viewed, ! changed-after-review, and ◆ composes", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      selection: { fileKey: "src/validation.ts", hunkIndex: 0 },
      viewed: {
        "src/payment.ts": { fileKey: "src/payment.ts", path: "src/payment.ts", contentId: "c-payment", generationId: "g", viewedAt: "now" },
        "src/validation.ts": { fileKey: "src/validation.ts", path: "src/validation.ts", contentId: "old-wrong", generationId: "g", viewedAt: "now" },
        "src/types.ts": { fileKey: "src/types.ts", path: "src/types.ts", contentId: "c-types", generationId: "g", viewedAt: "now" },
      } as unknown as ReviewState["viewed"],
      feedback: [
        { id: "fb1", kind: "note", severity: "comment", body: "x", anchor: { kind: "file", fileKey: "src/validation.ts", contentId: "c-validation" }, resolution: "active", createdAt: "now", updatedAt: "now" },
        { id: "fb2", kind: "note", severity: "comment", body: "y", anchor: { kind: "file", fileKey: "src/types.ts", contentId: "c-types" }, resolution: "active", createdAt: "now", updatedAt: "now" },
      ] as unknown as ReviewState["feedback"],
    })
    const rows = reviewFileRows(state)
    const byKey = new Map(rows.map((r) => [r.fileKey, r]))
    expect(byKey.get("src/payment.ts")?.marker).toBe("●")
    const validationMarker = byKey.get("src/validation.ts")?.marker ?? ""
    expect(validationMarker).toContain("!")
    expect(validationMarker).toContain("◆")
    const typesMarker = byKey.get("src/types.ts")?.marker ?? ""
    expect(typesMarker).toContain("●")
    expect(typesMarker).toContain("◆")
    expect(byKey.get("src/tests.ts")?.marker).toBe("○")
    const reviewingState = makeState({ files, selection: { fileKey: "src/tests.ts", hunkIndex: 0 }, viewed: {} as unknown as ReviewState["viewed"] })
    const reviewingRows = reviewFileRows(reviewingState)
    const reviewingMarker = reviewingRows.find((r) => r.fileKey === "src/tests.ts")?.marker
    expect(reviewingMarker).toBe("◐")
  })

  test("◆ composes rather than replaces coverage glyph", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      viewed: {
        "src/payment.ts": { fileKey: "src/payment.ts", path: "src/payment.ts", contentId: "c-payment", generationId: "g", viewedAt: "now" },
      } as unknown as ReviewState["viewed"],
      feedback: [
        { id: "fb1", kind: "note", severity: "comment", body: "x", anchor: { kind: "file", fileKey: "src/payment.ts", contentId: "c-payment" }, resolution: "active", createdAt: "now", updatedAt: "now" },
      ] as unknown as ReviewState["feedback"],
    })
    const row = reviewFileRows(state).find((r) => r.fileKey === "src/payment.ts")!
    expect(row.marker).toContain("●")
    expect(row.marker).toContain("◆")
    expect(row.marker.length).toBeGreaterThan(1)
  })
})

describe("reviewFileRows — filters", () => {
  test("all filter shows all files", () => {
    const state = makeState({ filter: { query: "", scope: "all" } })
    expect(reviewFileRows(state)).toHaveLength(4)
  })

  test("unreviewed filter shows only not-viewed and reviewing", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      selection: { fileKey: "src/tests.ts", hunkIndex: 0 },
      filter: { query: "", scope: "unreviewed" },
      viewed: {
        "src/payment.ts": { fileKey: "src/payment.ts", path: "src/payment.ts", contentId: "c-payment", generationId: "g", viewedAt: "now" },
      } as unknown as ReviewState["viewed"],
    })
    const rows = reviewFileRows(state)
    const keys = rows.map((r) => r.fileKey)
    expect(keys).not.toContain("src/payment.ts")
    expect(keys).toContain("src/validation.ts")
    expect(keys).toContain("src/tests.ts")
  })

  test("changed filter shows only changed-after-review", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      filter: { query: "", scope: "changed" },
      viewed: {
        "src/payment.ts": { fileKey: "src/payment.ts", path: "src/payment.ts", contentId: "wrong", generationId: "g", viewedAt: "now" },
        "src/validation.ts": { fileKey: "src/validation.ts", path: "src/validation.ts", contentId: "c-validation", generationId: "g", viewedAt: "now" },
      } as unknown as ReviewState["viewed"],
    })
    const rows = reviewFileRows(state)
    expect(rows.map((r) => r.fileKey)).toEqual(["src/payment.ts"])
  })

  test("feedback filter shows only files with pending feedback", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      filter: { query: "", scope: "feedback" },
      feedback: [
        { id: "fb1", kind: "note", severity: "comment", body: "x", anchor: { kind: "file", fileKey: "src/validation.ts", contentId: "c-validation" }, resolution: "active", createdAt: "now", updatedAt: "now" },
      ] as unknown as ReviewState["feedback"],
    })
    const rows = reviewFileRows(state)
    expect(rows.map((r) => r.fileKey)).toEqual(["src/validation.ts"])
  })

  test("text filter matches over current path and previousPath", () => {
    const files: ReviewFile[] = [
      ...makeFiles(),
      {
        key: "src/renamed.ts",
        path: "src/renamed.ts",
        previousPath: "src/oldname.ts",
        kind: "renamed",
        oldBlobOid: "o5",
        newBlobOid: "n5",
        oldMode: "100644",
        newMode: "100644",
        contentId: "c-renamed",
        patchDigest: "p5",
        stats: { additions: 1, deletions: 1 },
        hunks: [],
        source: "available",
      },
    ]
    const state = makeState({ files, filter: { query: "oldname", scope: "all" } })
    const rows = reviewFileRows(state)
    expect(rows.map((r) => r.fileKey)).toEqual(["src/renamed.ts"])
    const state2 = makeState({ files, filter: { query: "renamed", scope: "all" } })
    expect(reviewFileRows(state2).map((r) => r.fileKey)).toEqual(["src/renamed.ts"])
    const state3 = makeState({ files, filter: { query: "payment", scope: "all" } })
    expect(reviewFileRows(state3).map((r) => r.fileKey)).toEqual(["src/payment.ts"])
  })

  test("filter + scope combine — feedback scope with query", () => {
    const files = makeFiles()
    const state = makeState({
      files,
      filter: { query: "validation", scope: "feedback" },
      feedback: [
        { id: "fb1", kind: "note", severity: "comment", body: "x", anchor: { kind: "file", fileKey: "src/validation.ts", contentId: "c-validation" }, resolution: "active", createdAt: "now", updatedAt: "now" },
        { id: "fb2", kind: "note", severity: "comment", body: "y", anchor: { kind: "file", fileKey: "src/payment.ts", contentId: "c-payment" }, resolution: "active", createdAt: "now", updatedAt: "now" },
      ] as unknown as ReviewState["feedback"],
    })
    const rows = reviewFileRows(state)
    expect(rows.map((r) => r.fileKey)).toEqual(["src/validation.ts"])
  })
})

describe("reviewFileRows — pure projection", () => {
  test("returns styled spans without mutating state", () => {
    const state = makeState()
    const rows1 = reviewFileRows(state)
    const rows2 = reviewFileRows(state)
    expect(rows1).toEqual(rows2)
    for (const row of rows1) {
      expect(row.spans).toBeDefined()
      expect(Array.isArray(row.spans)).toBe(true)
    }
  })
})

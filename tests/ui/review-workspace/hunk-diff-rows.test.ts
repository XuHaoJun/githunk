import { describe, expect, test } from "bun:test"
import { createFileAnchor } from "../../../src/review/core/anchors"
import { createInitialReviewState } from "../../../src/review/core/state"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import { buildHunkSplitRows, buildHunkStackRows } from "../../../src/ui/review-workspace/hunk-diff-rows"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFile(): ReviewFile {
  return {
    key: "src/example.ts",
    path: "src/example.ts",
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: "content-example",
    patchDigest: "patch-example",
    stats: { additions: 1, deletions: 2 },
    hunks: [
      createReviewHunk({
        index: 0,
        oldStart: 10,
        oldCount: 4,
        newStart: 10,
        newCount: 3,
        lines: [
          " context before",
          "-const oldA = 1",
          "-const oldB = 2",
          "+const next = 3",
          " context after",
        ],
      }),
    ],
    source: "available",
  }
}

function makeState(file: ReviewFile) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files: [file] }))
}

describe("Hunk-derived diff rows", () => {
  test("pairs split changes and pads the shorter side", () => {
    const file = makeFile()
    const adapted = toHunkReviewFile(file)
    const rows = buildHunkSplitRows(adapted, makeState(file), undefined, { width: 120, showLineNumbers: true, wrapLines: false })
    const splitRows = rows.filter((row) => row.type === "split-line")

    expect(splitRows).toHaveLength(4)
    expect(splitRows[1]).toMatchObject({
      left: { kind: "deletion", lineNumber: 11 },
      right: { kind: "addition", lineNumber: 11 },
    })
    expect(splitRows[2]).toMatchObject({
      left: { kind: "deletion", lineNumber: 12 },
      right: { kind: "empty" },
    })
  })

  test("stack rows preserve deletion-before-addition ordering", () => {
    const file = makeFile()
    const adapted = toHunkReviewFile(file)
    const rows = buildHunkStackRows(adapted, makeState(file), undefined, { width: 120, showLineNumbers: true, wrapLines: false })
    const codeRows = rows.filter((row) => row.type === "stack-line")

    expect(codeRows.map((row) => row.type === "stack-line" ? row.cell.kind : "other")).toEqual([
      "context",
      "deletion",
      "deletion",
      "addition",
      "context",
    ])
    expect(codeRows[1]?.cell.oldLineNumber).toBe(11)
    expect(codeRows[1]?.cell.newLineNumber).toBeUndefined()
    expect(codeRows[3]?.cell.oldLineNumber).toBeUndefined()
    expect(codeRows[3]?.cell.newLineNumber).toBe(11)
  })
  test("emits a collapsed gap before a later hunk", () => {
    const file: ReviewFile = {
      ...makeFile(),
      contentId: "content-two-hunks",
      hunks: [
        createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] }),
        createReviewHunk({ index: 1, oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, lines: ["-old2", "+new2"] }),
      ],
    }
    const rows = buildHunkStackRows(toHunkReviewFile(file), makeState(file), undefined, { width: 120, showLineNumbers: true, wrapLines: false })
    const gap = rows.find((row) => row.type === "collapsed")

    expect(gap).toMatchObject({ fileKey: file.key, gapId: "before:1", lineCount: 3, expanded: false })
  })
  test("renders cached expanded gap source with context gutters", () => {
    const file: ReviewFile = {
      ...makeFile(),
      contentId: "content-expanded-gap",
      hunks: [
        createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] }),
        createReviewHunk({ index: 1, oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, lines: ["-old2", "+new2"] }),
      ],
    }
    const state = makeState(file)
    const expandedState = { ...state, expandedGaps: [{ fileKey: file.key, gapId: "before:1", expanded: true }] }
    const rows = buildHunkSplitRows(toHunkReviewFile(file), expandedState, undefined, {
      width: 120,
      showLineNumbers: true,
      wrapLines: false,
      expandedSourceByGap: new Map([[`${file.key}:before:1`, ["line2", "line3", "line4"]]]),
    })
    const expansion = rows.filter((row) => row.type === "split-line" && row.isExpansionRow)

    expect(rows.some((row) => row.type === "collapsed")).toBe(false)
    expect(expansion).toHaveLength(3)
    expect(expansion[0]).toMatchObject({ left: { kind: "context", lineNumber: 2 }, right: { kind: "context", lineNumber: 2 } })
  })
  test("keeps pending feedback in the file stream", () => {
    const file = makeFile()
    const state = makeState(file)
    const feedbackState = {
      ...state,
      feedback: [{
        id: "feedback-1",
        kind: "note" as const,
        severity: "blocking" as const,
        body: "address the edge case",
        anchor: createFileAnchor(file),
        resolution: "active" as const,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }],
    }
    const rows = buildHunkStackRows(toHunkReviewFile(file), feedbackState, undefined, { width: 120, showLineNumbers: true, wrapLines: false })
    const feedback = rows.find((row) => row.type === "feedback")

    expect(feedback).toMatchObject({ feedbackId: "feedback-1", severity: "blocking", resolution: "active" })
  })
})

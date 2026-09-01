import { describe, expect, test } from "bun:test"
import { createReviewHunk } from "../../../src/review/core/document"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFile(overrides: Partial<ReviewFile> = {}): ReviewFile {
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
    ...overrides,
  }
}

describe("Hunk review model adapter", () => {
  test("groups context and contiguous changes into Pierre hunk content", () => {
    const adapted = toHunkReviewFile(makeFile())
    const hunk = adapted.metadata.hunks[0]

    expect(adapted.id).toBe("src/example.ts")
    expect(hunk).toBeDefined()
    expect(hunk!.hunkContent.map((content) => content.type)).toEqual(["context", "change", "context"])
    expect(hunk!.hunkContent[1]).toMatchObject({ type: "change", deletions: 2, additions: 1 })
  })

  test("preserves rename identity and side availability", () => {
    const adapted = toHunkReviewFile(makeFile({
      key: "src/new.ts",
      path: "src/new.ts",
      previousPath: "src/old.ts",
      kind: "renamed",
      newBlobOid: "3".repeat(40),
    }))

    expect(adapted.path).toBe("src/new.ts")
    expect(adapted.previousPath).toBe("src/old.ts")
    expect(adapted.metadata.prevName).toBe("src/old.ts")
  })

  test("keeps binary files out of line rendering", () => {
    const adapted = toHunkReviewFile(makeFile({
      key: "image.png",
      path: "image.png",
      kind: "binary",
      source: "binary",
      hunks: [],
    }))

    expect(adapted.kind).toBe("binary")
    expect(adapted.metadata.hunks).toHaveLength(0)
    expect(adapted.metadata.deletionLines).toHaveLength(0)
    expect(adapted.metadata.additionLines).toHaveLength(0)
  })
  test("keeps deleted files on the old side only", () => {
    const adapted = toHunkReviewFile(makeFile({
      key: "src/removed.ts",
      path: "src/removed.ts",
      kind: "deleted",
      newBlobOid: null,
      hunks: [
        createReviewHunk({
          index: 0,
          oldStart: 1,
          oldCount: 2,
          newStart: 0,
          newCount: 0,
          lines: ["-const gone = true", "-export default gone"],
        }),
      ],
    }))

    expect(adapted.metadata.type).toBe("deleted")
    expect(adapted.metadata.deletionLines).toHaveLength(2)
    expect(adapted.metadata.additionLines).toHaveLength(0)
  })
})

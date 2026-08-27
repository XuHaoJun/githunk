import { describe, expect, test } from "bun:test"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createRangeAnchor, createFileAnchor, reconcileAnchor } from "../../../src/review/core/anchors"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"
import { createReviewHunk } from "../../../src/review/core/document"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "main" })
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

describe("anchors", () => {
  test("file anchor uses fileKey and contentId", () => {
    const file = makeFile({ key: "a", path: "src/a.ts", contentId: "cid1" })
    const anchor = createFileAnchor(file)
    expect(anchor).toMatchObject({ kind: "file", fileKey: file.key, contentId: file.contentId })
  })

  test("range anchor inclusive new range with precise source lines", () => {
    const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " c"] })
    const file = makeFile({ key: "a", path: "src/a.ts", contentId: "cid1", hunks: [hunk] as unknown as ReviewFile["hunks"] })
    const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 2 })
    expect(anchor).toMatchObject({ kind: "range", fileKey: file.key, contentId: file.contentId, side: "new", startLine: 1, endLine: 2 })
    if (anchor.kind === "range") {
      expect(anchor.startLine).toBe(1)
      expect(anchor.endLine).toBe(2)
      expect(typeof anchor.ownerHunkIndex).toBe("number")
      expect(typeof anchor.contextDigest).toBe("string")
    }
  })

  test("rejects zero and reversed ranges", () => {
    const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 5, newStart: 1, newCount: 5, lines: [" a", " b", " c", " d", " e"] })
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [hunk] as unknown as ReviewFile["hunks"] })
    expect(() => createRangeAnchor(file, { side: "new", startLine: 0, endLine: 1 } as unknown as { side: "new"; startLine: number; endLine: number })).toThrow()
    expect(() => createRangeAnchor(file, { side: "new", startLine: 5, endLine: 3 } as unknown as { side: "new"; startLine: number; endLine: number })).toThrow()
  })

  test("owner hunk assignment picks correct hunk", () => {
    const h1 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " c"] })
    const h2 = createReviewHunk({ index: 1, oldStart: 10, oldCount: 3, newStart: 10, newCount: 3, lines: [" x", " y", " z"] })
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h1, h2] as unknown as ReviewFile["hunks"] })
    const anchor1 = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 2 })
    const anchor2 = createRangeAnchor(file, { side: "new", startLine: 11, endLine: 11 })
    expect((anchor1 as unknown as { ownerHunkIndex: number }).ownerHunkIndex).toBe(0)
    expect((anchor2 as unknown as { ownerHunkIndex: number }).ownerHunkIndex).toBe(1)
  })

  test("unique context relocation keeps active", () => {
    const hOld = createReviewHunk({ index: 0, oldStart: 1, oldCount: 5, newStart: 1, newCount: 5, lines: [" a", " b", " target", " d", " e"] })
    const oldFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-old", hunks: [hOld] as unknown as ReviewFile["hunks"] })
    const oldAnchor = createRangeAnchor(oldFile, { side: "new", startLine: 3, endLine: 3 }) as unknown as Extract<import("../../../src/review/core/types").ReviewAnchor, { kind: "range" }>

    const hNew = createReviewHunk({ index: 0, oldStart: 1, oldCount: 5, newStart: 10, newCount: 5, lines: [" a", " b", " target", " d", " e"] })
    const newFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-new", hunks: [hNew] as unknown as ReviewFile["hunks"] })
    const doc = createReviewDocument({ identity: makeIdentity(), generation: makeGeneration({ headOid: "h2" }), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files: [newFile] })
    const result = reconcileAnchor(oldAnchor, doc)
    expect(result.resolution).toBe("active")
    expect(result.anchor.fileKey).toBe("a")
    if (result.anchor.kind === "range") expect(result.anchor.startLine).toBe(12)
  })

  test("stale when same file without unique match", () => {
    const hOld = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " unique"] })
    const oldFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-old", hunks: [hOld] as unknown as ReviewFile["hunks"] })
    const oldAnchor = createRangeAnchor(oldFile, { side: "new", startLine: 3, endLine: 3 }) as unknown as Extract<import("../../../src/review/core/types").ReviewAnchor, { kind: "range" }>
    const hNew = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" x", " y", " z"] })
    const newFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-new2", hunks: [hNew] as unknown as ReviewFile["hunks"] })
    const doc = createReviewDocument({ identity: makeIdentity(), generation: makeGeneration({ headOid: "h2" }), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files: [newFile] })
    const result = reconcileAnchor(oldAnchor, doc)
    expect(result.resolution).toBe("stale")
  })

  test("never chooses first of multiple matches -> stale", () => {
    const hOld = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " dup", " c"] })
    const oldFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-old", hunks: [hOld] as unknown as ReviewFile["hunks"] })
    const oldAnchor = createRangeAnchor(oldFile, { side: "new", startLine: 2, endLine: 2 }) as unknown as Extract<import("../../../src/review/core/types").ReviewAnchor, { kind: "range" }>
    const hNew1 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" dup", " x"] })
    const hNew2 = createReviewHunk({ index: 1, oldStart: 10, oldCount: 2, newStart: 10, newCount: 2, lines: [" dup", " y"] })
    const newFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-new3", hunks: [hNew1, hNew2] as unknown as ReviewFile["hunks"] })
    const doc = createReviewDocument({ identity: makeIdentity(), generation: makeGeneration({ headOid: "h2" }), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files: [newFile] })
    const result = reconcileAnchor(oldAnchor, doc)
    expect(result.resolution).toBe("stale")
  })

  test("orphaned when file deleted", () => {
    const hOld = createReviewHunk({ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" a", " b"] })
    const oldFile = makeFile({ key: "a", path: "src/a.ts", contentId: "cid-old", hunks: [hOld] as unknown as ReviewFile["hunks"] })
    const oldAnchor = createRangeAnchor(oldFile, { side: "new", startLine: 1, endLine: 1 }) as unknown as Extract<import("../../../src/review/core/types").ReviewAnchor, { kind: "range" }>
    const doc = createReviewDocument({ identity: makeIdentity(), generation: makeGeneration({ headOid: "h2" }), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" } as unknown as ReviewDocument["commits"][number]], files: [] })
    const result = reconcileAnchor(oldAnchor, doc)
    expect(result.resolution).toBe("orphaned")
  })
})

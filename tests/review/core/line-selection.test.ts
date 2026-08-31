import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { createLineSelection } from "../../../src/review/core/anchors"
import { moveReviewLineSelection } from "../../../src/review/core/navigation"
import { reduceReviewState } from "../../../src/review/core/reducer"
import type { ReviewFile } from "../../../src/review/core/types"

function file(): ReviewFile {
  const hunk = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " c"] })
  return { kind: "modified", contentId: "cid", patchDigest: "p", stats: { additions: 0, deletions: 0 }, hunks: [hunk], source: "available", key: "a", path: "a.ts" } as unknown as ReviewFile
}
function doc() {
  return createReviewDocument({ identity: createReviewIdentity({ headRef: "refs/heads/main", headOid: "h", baseRef: "main" }), generation: createReviewGeneration({ mergeBaseOid: "m", baseOid: "b", headOid: "h" }), commits: [], files: [file()] })
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
})

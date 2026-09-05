import { describe, expect, test } from "bun:test"
import { createInitialReviewState } from "../../../src/review/core/state"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import { hunkSectionRowCount } from "../../../src/ui/review-workspace/components/ReviewDiffSection"
import { resolveStickyDiffHeader } from "../../../src/ui/review-workspace/sticky-header"
import type { HunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFile(overrides: Partial<ReviewFile> & Pick<ReviewFile, "key" | "path" | "contentId">): ReviewFile {
  return {
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    patchDigest: `patch-${overrides.key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [
      createReviewHunk({ index: 0, oldStart: 10, oldCount: 1, newStart: 10, newCount: 1, lines: ["-old", "+new"] }),
    ],
    source: "available",
    ...overrides,
  }
}

function twoHunkFile(): ReviewFile {
  return makeFile({
    key: "src/two.ts",
    path: "src/two.ts",
    contentId: "content-two",
    hunks: [
      createReviewHunk({ index: 0, oldStart: 10, oldCount: 1, newStart: 10, newCount: 1, lines: ["-old", "+new"] }),
      createReviewHunk({ index: 1, oldStart: 40, oldCount: 1, newStart: 40, newCount: 1, lines: ["-old2", "+new2"] }),
    ],
  })
}

function makeState(files: readonly ReviewFile[]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files: [...files] }))
}

// Mirrors ReviewDiffPane.sectionWindow: absolute row offset of each section,
// with the inter-file divider counted from the second section onward.
function sectionOffsets(files: readonly HunkReviewFile[], state: ReturnType<typeof makeState>, layout: "split" | "stack"): readonly number[] {
  const offsets: number[] = [0]
  let total = 0
  files.forEach((file, index) => {
    total += hunkSectionRowCount(file, layout, state, undefined, index > 0)
    offsets.push(total)
  })
  return offsets
}

describe("Sticky diff header", () => {
  test("returns nothing when the stream is empty", () => {
    const state = makeState([])
    expect(resolveStickyDiffHeader({ files: [], state, layout: "stack", scrollTop: 0, sectionOffsets: [0] })).toBeUndefined()
  })

  test("reports the file with no hunk while the file header is at the viewport top", () => {
    const file = twoHunkFile()
    const state = makeState([file])
    const files = [toHunkReviewFile(file)]

    const sticky = resolveStickyDiffHeader({
      files,
      state,
      layout: "stack",
      scrollTop: 0,
      sectionOffsets: sectionOffsets(files, state, "stack"),
    })

    expect(sticky).toEqual({ fileKey: file.key, filePath: file.path, hunkIndex: -1 })
  })

  test("reports the enclosing hunk once its body is at the viewport top", () => {
    const file = twoHunkFile()
    const state = makeState([file])
    const files = [toHunkReviewFile(file)]
    // section rows: [0] file header, [1] hunk 0 header, [2..3] hunk 0 body.
    const sticky = resolveStickyDiffHeader({
      files,
      state,
      layout: "stack",
      scrollTop: 2,
      sectionOffsets: sectionOffsets(files, state, "stack"),
    })

    expect(sticky).toEqual({
      fileKey: file.key,
      filePath: file.path,
      hunkIndex: 0,
      hunkText: "@@ -10,1 +10,1 @@",
    })
  })

  test("keeps the previous hunk while the collapsed gap row is at the viewport top", () => {
    const file = twoHunkFile()
    const state = makeState([file])
    const files = [toHunkReviewFile(file)]
    // section rows: [0] header, [1] hunk 0 header, [2..3] body, [4] collapsed gap, [5] hunk 1 header.
    const sticky = resolveStickyDiffHeader({
      files,
      state,
      layout: "stack",
      scrollTop: 4,
      sectionOffsets: sectionOffsets(files, state, "stack"),
    })

    expect(sticky).toMatchObject({ hunkIndex: 0 })
  })

  test("advances to the later hunk once its header is at the viewport top", () => {
    const file = twoHunkFile()
    const state = makeState([file])
    const files = [toHunkReviewFile(file)]

    const sticky = resolveStickyDiffHeader({
      files,
      state,
      layout: "stack",
      scrollTop: 5,
      sectionOffsets: sectionOffsets(files, state, "stack"),
    })

    expect(sticky).toEqual({
      fileKey: file.key,
      filePath: file.path,
      hunkIndex: 1,
      hunkText: "@@ -40,1 +40,1 @@",
    })
  })

  test("holds the outgoing file until the next file's header has scrolled past", () => {
    const first = makeFile({ key: "src/first.ts", path: "src/first.ts", contentId: "content-first" })
    const second = makeFile({ key: "src/second.ts", path: "src/second.ts", contentId: "content-second" })
    const state = makeState([first, second])
    const files = [toHunkReviewFile(first), toHunkReviewFile(second)]
    const offsets = sectionOffsets(files, state, "stack")
    const secondTop = offsets[1]!
    const at = (scrollTop: number) => resolveStickyDiffHeader({ files, state, layout: "stack", scrollTop, sectionOffsets: offsets })

    expect(at(secondTop - 1)).toMatchObject({ fileKey: first.key })
    // The divider row opening the second section still belongs to the first file.
    expect(at(secondTop)).toMatchObject({ fileKey: first.key })
    // So does the row where the second file's own header is visible in the stream:
    // pinning it here would show the same header twice.
    expect(at(secondTop + 1)).toMatchObject({ fileKey: first.key })
    // Once that header has scrolled off, the pinned row takes it over.
    expect(at(secondTop + 2)).toEqual({
      fileKey: second.key,
      filePath: second.path,
      hunkIndex: 0,
      hunkText: "@@ -10,1 +10,1 @@",
    })
  })

  test("clamps a scroll position past the end of the stream to the last file", () => {
    const first = makeFile({ key: "src/first.ts", path: "src/first.ts", contentId: "content-first" })
    const second = makeFile({ key: "src/second.ts", path: "src/second.ts", contentId: "content-second" })
    const state = makeState([first, second])
    const files = [toHunkReviewFile(first), toHunkReviewFile(second)]
    const offsets = sectionOffsets(files, state, "stack")

    expect(resolveStickyDiffHeader({ files, state, layout: "stack", scrollTop: offsets[2]! + 50, sectionOffsets: offsets }))
      .toMatchObject({ fileKey: second.key })
    expect(resolveStickyDiffHeader({ files, state, layout: "stack", scrollTop: -5, sectionOffsets: offsets }))
      .toMatchObject({ fileKey: first.key })
  })

  test("uses split geometry when the pane is in split layout", () => {
    const file = twoHunkFile()
    const state = makeState([file])
    const files = [toHunkReviewFile(file)]
    // Split pairs the deletion and addition onto one row, so hunk 1's header
    // lands on row 4 instead of row 5 and row 4 is still the gap in stack.
    const offsets = sectionOffsets(files, state, "split")

    expect(resolveStickyDiffHeader({ files, state, layout: "split", scrollTop: 4, sectionOffsets: offsets }))
      .toMatchObject({ hunkIndex: 1 })
    expect(resolveStickyDiffHeader({ files, state, layout: "stack", scrollTop: 4, sectionOffsets: sectionOffsets(files, state, "stack") }))
      .toMatchObject({ hunkIndex: 0 })
  })

  test("reports a binary file with no hunk", () => {
    const binary = makeFile({ key: "logo.png", path: "logo.png", contentId: "content-binary", hunks: [], source: "binary" })
    const state = makeState([binary])
    const files = [toHunkReviewFile(binary)]

    expect(resolveStickyDiffHeader({ files, state, layout: "stack", scrollTop: 1, sectionOffsets: sectionOffsets(files, state, "stack") }))
      .toEqual({ fileKey: binary.key, filePath: binary.path, hunkIndex: -1 })
  })
})

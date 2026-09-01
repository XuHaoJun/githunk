import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { hunkDiffAddresses, buildHunkStackRows } from "../../../src/ui/review-workspace/hunk-diff-row-model"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import { REVIEW_CONFORMANCE_FIXTURES, computeContentId, normalizedHunkBodyForFixture } from "./corpus"
import type { ReviewFile } from "../../../src/review/core/types"

function makeDocForFixture(fixture: (typeof REVIEW_CONFORMANCE_FIXTURES)[number]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const files: ReviewFile[] = fixture.expected.files.map((expected) => {
    const raw = fixture.rawEntries.find((entry) => entry.path === expected.path || entry.path === expected.previousPath)
    const body = normalizedHunkBodyForFixture(expected)
    return {
      key: expected.key,
      path: expected.path,
      ...(expected.previousPath ? { previousPath: expected.previousPath } : {}),
      kind: expected.kind,
      oldBlobOid: raw?.oldBlobOid ?? null,
      newBlobOid: raw?.newBlobOid ?? null,
      oldMode: raw?.oldMode ?? null,
      newMode: raw?.newMode ?? null,
      contentId: raw ? computeContentId(raw, body) : sha256Tuple(["", "", "", "", body]),
      patchDigest: sha256Tuple([body]),
      stats: expected.stats,
      hunks: expected.hunks.map((hunk) => createReviewHunk({ ...hunk, lines: [...hunk.lines] })),
      source: expected.source,
    }
  })
  return createReviewDocument({ identity, generation, commits: [], files })
}

function normalizedLineSlice(lines: readonly string[], start: number, count: number): readonly string[] {
  return lines.slice(start, start + count).map((line) => line.replace(/\n$/u, ""))
}

describe("conformance: active normalized Hunk rows", () => {
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    test(`${fixture.id}: ${fixture.description}`, () => {
      const state = createInitialReviewState(makeDocForFixture(fixture))
      const rowsByFile = new Map(state.document.files.map((file) => {
        const hunkFile = toHunkReviewFile(file)
        return [file.key, buildHunkStackRows(hunkFile, state, undefined, { width: 120, showLineNumbers: true, wrapLines: false })] as const
      }))

      for (const expected of fixture.expected.files) {
        const file = state.document.files.find((candidate) => candidate.key === expected.key)
        expect(file).toBeDefined()
        const hunkFile = toHunkReviewFile(file!)
        expect(hunkFile.metadata.name).toBe(expected.path)
        expect(hunkFile.metadata.hunks).toHaveLength(expected.hunks.length)
        for (const [index, hunk] of expected.hunks.entries()) {
          const normalized = hunkFile.metadata.hunks[index]
          expect(normalized).toBeDefined()
          expect(normalized).toMatchObject({
            deletionStart: hunk.oldStart,
            deletionCount: hunk.oldCount,
            additionStart: hunk.newStart,
            additionCount: hunk.newCount,
          })
          const deletionLines = normalized
            ? normalizedLineSlice(hunkFile.metadata.deletionLines, normalized.deletionLineIndex, hunk.oldCount)
            : []
          const additionLines = normalized
            ? normalizedLineSlice(hunkFile.metadata.additionLines, normalized.additionLineIndex, hunk.newCount)
            : []
          expect(deletionLines).toEqual(hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.replace(/^[- ]/u, "")))
          expect(additionLines).toEqual(hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.replace(/^[+ ]/u, "")))
        }
      }

      for (const sample of fixture.expected.rowAddresses) {
        if (sample.hunkIndex === null) {
          expect(state.document.files.some((file) => file.key === sample.fileKey)).toBe(true)
          continue
        }
        const rows = rowsByFile.get(sample.fileKey) ?? []
        const addresses = rows.flatMap((row) => hunkDiffAddresses(row))
        expect(addresses.some((address) =>
          address.fileKey === sample.fileKey &&
          address.hunkIndex === sample.hunkIndex &&
          ((sample.oldLine !== null && address.side === "old" && address.line === sample.oldLine) ||
            (sample.newLine !== null && address.side === "new" && address.line === sample.newLine)),
        )).toBe(true)
      }
    })
  }
})

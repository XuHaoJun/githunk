import { createReviewDocument, createReviewHunk } from "../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../src/review/core/identity"
import { createInitialReviewState } from "../src/review/core/state"
import type { ReviewFile } from "../src/review/core/types"
import { buildHunkStackRows } from "../src/ui/review-workspace/hunk-diff-row-model"
import { toHunkReviewFile } from "../src/ui/review-workspace/hunk-review-model"
import { REVIEW_CONFORMANCE_FIXTURES, computeContentId, normalizedHunkBodyForFixture } from "../tests/review/conformance/corpus"

function makeDocForFixture(fixture: (typeof REVIEW_CONFORMANCE_FIXTURES)[number]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const files: ReviewFile[] = fixture.expected.files.map((ef) => {
    const raw = fixture.rawEntries.find((r) => r.path === ef.path)
    const body = normalizedHunkBodyForFixture(ef)
    const contentId = raw ? computeContentId(raw, body) : sha256Tuple(["", "", "", "", body])
    const patchDigest = sha256Tuple([body])
    const hunks = ef.hunks.map((h) => createReviewHunk({ index: h.index, oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart, newCount: h.newCount, lines: [...h.lines] }))
    return {
      key: ef.key,
      path: ef.path,
      ...(ef.previousPath ? { previousPath: ef.previousPath } : {}),
      kind: ef.kind,
      oldBlobOid: raw?.oldBlobOid ?? null,
      newBlobOid: raw?.newBlobOid ?? null,
      oldMode: raw?.oldMode ?? null,
      newMode: raw?.newMode ?? null,
      contentId,
      patchDigest,
      stats: ef.stats,
      hunks,
      source: ef.source,
    }
  })
  return createReviewDocument({ identity, generation, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}
async function main() {
  const beforeHeap = process.memoryUsage().heapUsed
  const start = performance.now()
  let totalRowsBuilt = 0
  let maxRowsInViewport = 0
  let fixtureSize = 0
  const viewportHeight = 40
  const overscan = 8
  const width = 120
  const rowOptions = { width, showLineNumbers: true, wrapLines: false } as const
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    fixtureSize += fixture.patch.length
    const state = createInitialReviewState(makeDocForFixture(fixture))
    for (const file of state.document.files) {
      const rows = buildHunkStackRows(toHunkReviewFile(file), state, undefined, rowOptions)
      totalRowsBuilt += rows.length
      maxRowsInViewport = Math.max(maxRowsInViewport, rows.slice(0, viewportHeight + overscan * 2).length)
    }
  }

  // Large document stress on the active normalized adapter and Hunk row model.
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const manyFiles: ReviewFile[] = Array.from({ length: 500 }, (_, i) => ({
    key: `file-${i}.ts`,
    path: `file-${i}.ts`,
    kind: "modified" as const,
    oldBlobOid: "a".repeat(40),
    newBlobOid: "b".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: sha256Tuple([`file-${i}`]),
    patchDigest: sha256Tuple([`file-${i}`]),
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", "-old", "+new", " b"] })],
    source: "available" as const,
  }))
  const largeState = createInitialReviewState(createReviewDocument({ identity, generation, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files: manyFiles }))
  let largeTotalRows = 0
  for (const file of largeState.document.files) {
    largeTotalRows += buildHunkStackRows(toHunkReviewFile(file), largeState, undefined, rowOptions).length
  }
  const largeViewportRows = Math.min(largeTotalRows, viewportHeight + overscan * 2)
  if (largeViewportRows >= largeTotalRows) {
    console.error(`large document unexpectedly fits viewport: rows ${largeViewportRows} total ${largeTotalRows}`)
    process.exit(1)
  }


  const elapsedMs = performance.now() - start
  const heapDelta = process.memoryUsage().heapUsed - beforeHeap
  const output = {
    benchmark: "review-row-plan",
    fixtureSize,
    fixtureCount: REVIEW_CONFORMANCE_FIXTURES.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    heapDeltaBytes: heapDelta,
    heapDeltaMiB: Math.round((heapDelta / 1024 / 1024) * 100) / 100,
    outputCount: { totalRowsBuilt, maxRowsInViewport, largeTotalRows, largeViewportRows },
    assertion: `active Hunk stack rows expose a viewport sample (${viewportHeight}) + overscan (${overscan}) and retain ${largeTotalRows} rows for the 500-file document`,
  }
  console.log(JSON.stringify(output, null, 2))
}

await main()

import { createReviewDocument, createReviewHunk } from "../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../src/review/core/identity"
import { createInitialReviewState } from "../src/review/core/state"
import { DEFAULT_OVERSCAN, __clearRowPlannerCache, planReviewRows } from "../src/ui/review-workspace/row-planner"
import { REVIEW_CONFORMANCE_FIXTURES, computeContentId, normalizedHunkBodyForFixture } from "../tests/review/conformance/corpus"
import type { ReviewFile } from "../src/review/core/types"

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
  __clearRowPlannerCache()
  const beforeHeap = process.memoryUsage().heapUsed
  const start = performance.now()
  let totalRowsPlanned = 0
  let maxRowsInViewport = 0
  let fixtureSize = 0
  const viewportHeight = 40
  const overscan = DEFAULT_OVERSCAN
  const width = 120
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    fixtureSize += fixture.patch.length
    const doc = makeDocForFixture(fixture)
    const state = createInitialReviewState(doc)
    const plan = planReviewRows(state, { width, viewportHeight, viewportStart: 0, showLineNumbers: true, wrapLines: false, effectiveMode: "stack", overscan })
    totalRowsPlanned += plan.totalRows
    maxRowsInViewport = Math.max(maxRowsInViewport, plan.rows.length)
    // Bounded assertion: viewport + overscan
    const bound = viewportHeight + overscan * 2
    if (plan.rows.length > bound) {
      console.error(`row planning exceeded bound for ${fixture.id}: ${plan.rows.length} > ${bound}`)
      process.exit(1)
    }
  }

  // Large document stress
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
  const largeDoc = createReviewDocument({ identity, generation, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files: manyFiles })
  const largeState = createInitialReviewState(largeDoc)
  const largePlan = planReviewRows(largeState, { width, viewportHeight, viewportStart: 0, showLineNumbers: true, wrapLines: false, effectiveMode: "stack", overscan })
  if (largePlan.rows.length > viewportHeight + overscan * 2) {
    console.error(`large plan exceeded bound: ${largePlan.rows.length} > ${viewportHeight + overscan * 2}`)
    process.exit(1)
  }
  // Also assert large totalRows >> rows (windowed)
  if (largePlan.rows.length >= largePlan.totalRows) {
    console.error(`large plan not windowed: rows ${largePlan.rows.length} total ${largePlan.totalRows}`)
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
    outputCount: { totalRowsPlanned, maxRowsInViewport, largeTotalRows: largePlan.totalRows, largeViewportRows: largePlan.rows.length },
    assertion: `rows bounded by viewport (${viewportHeight}) + overscan (${overscan}) *2 = ${viewportHeight + overscan * 2}; large windowed ${largePlan.rows.length} < ${largePlan.totalRows}`,
  }
  console.log(JSON.stringify(output, null, 2))
}

await main()

import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { DEFAULT_OVERSCAN, __clearRowPlannerCache, planReviewRows, sourceAddressAtViewportRow, sourceAddressForRow } from "../../../src/ui/review-workspace/row-planner"
import { REVIEW_CONFORMANCE_FIXTURES, computeContentId, normalizedHunkBodyForFixture } from "./corpus"
import type { ReviewFile } from "../../../src/review/core/types"

function makeDocForFixture(fixture: (typeof REVIEW_CONFORMANCE_FIXTURES)[number]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const files: ReviewFile[] = fixture.expected.files.map((ef) => {
    const raw = fixture.rawEntries.find((r) => r.path === ef.path)
    const normalizedBody = normalizedHunkBodyForFixture(ef)
    const contentId = raw ? computeContentId(raw, normalizedBody) : sha256Tuple(["", "", "", "", normalizedBody])
    const patchDigest = sha256Tuple([normalizedBody])
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

describe("conformance: row planner", () => {
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    test(`${fixture.id}: screen rows map back to expected source addresses`, () => {
      __clearRowPlannerCache()
      const doc = makeDocForFixture(fixture)
      const state = createInitialReviewState(doc)
      const opts = { width: 120, viewportHeight: 40, viewportStart: 0, showLineNumbers: true, wrapLines: false, effectiveMode: "stack" as const, overscan: DEFAULT_OVERSCAN }
      const plan = planReviewRows(state, opts)
      expect(plan.rows.length).toBeLessThanOrEqual(opts.viewportHeight + (opts.overscan ?? 0) * 2)
      expect(plan.totalRows).toBeGreaterThanOrEqual(plan.rows.length)
      for (const row of plan.rows) {
        const addr = sourceAddressForRow(row)
        if (addr) expect(addr.fileKey.length).toBeGreaterThan(0)
        if (row.kind === "diff") expect(addr?.hunkIndex).not.toBeNull()
      }
      if (fixture.expected.rowAddresses.length > 0) {
        const fullPlan = planReviewRows(state, { ...opts, viewportStart: 0, viewportHeight: Math.max(200, plan.totalRows), overscan: 10 })
        const allAddrs = fullPlan.rows.map((r) => sourceAddressForRow(r)).filter((a): a is NonNullable<ReturnType<typeof sourceAddressForRow>> => a !== null)
        for (const expected of fixture.expected.rowAddresses) {
          if (expected.marker === "binary" || expected.marker === "mode") {
            const headerFound = fullPlan.rows.some((r) => r.fileKey === expected.fileKey)
            expect(headerFound).toBe(true)
            continue
          }
          const found = allAddrs.some((a) => a.fileKey === expected.fileKey && a.hunkIndex === expected.hunkIndex && a.oldLine === expected.oldLine && a.newLine === expected.newLine)
          expect(found).toBe(true)
        }
      }
      if (fixture.id === "long-line") {
        const narrowWrap = planReviewRows(state, { ...opts, width: 40, wrapLines: true, effectiveMode: "stack" as const })
        const wideNoWrap = planReviewRows(state, { ...opts, width: 120, wrapLines: false, effectiveMode: "stack" as const })
        expect(narrowWrap.totalRows).toBeGreaterThanOrEqual(wideNoWrap.totalRows)
      }
      if (plan.rows.length > 0) {
        const firstRow = plan.rows[0]!
        const firstAddr = sourceAddressAtViewportRow(plan, plan.start)
        const firstRowAddr = sourceAddressForRow(firstRow)
        if (firstRow.kind === "diff") {
          expect(firstAddr).toEqual(firstRowAddr)
        } else {
          expect(firstAddr?.fileKey).toBe(firstRow.fileKey)
        }
      }
    })
  }

  test("windowed planning is bounded even for large synthetic document", () => {
    __clearRowPlannerCache()
    const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
    const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
    const manyFiles: ReviewFile[] = Array.from({ length: 200 }, (_, i) => ({
      key: `file-${i}.txt`,
      path: `file-${i}.txt`,
      kind: "modified" as const,
      oldBlobOid: "a".repeat(40),
      newBlobOid: "b".repeat(40),
      oldMode: "100644",
      newMode: "100644",
      contentId: sha256Tuple([`file-${i}`, "body"]),
      patchDigest: sha256Tuple([`file-${i}`]),
      stats: { additions: 1, deletions: 1 },
      hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", "-old", "+new", " b"] })],
      source: "available" as const,
    }))
    const doc = createReviewDocument({ identity, generation, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files: manyFiles })
    const state = createInitialReviewState(doc)
    const opts = { width: 120, viewportHeight: 40, viewportStart: 0, showLineNumbers: true, wrapLines: false, effectiveMode: "stack" as const, overscan: 10 }
    const plan = planReviewRows(state, opts)
    expect(plan.totalRows).toBeGreaterThan(100)
    expect(plan.rows.length).toBeLessThanOrEqual(opts.viewportHeight + (opts.overscan ?? 0) * 2)
    expect(plan.rows.length).toBeLessThan(plan.totalRows)
  })
})

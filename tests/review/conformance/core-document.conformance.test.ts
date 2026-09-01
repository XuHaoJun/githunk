import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../../../src/review/core/identity"
import { createFileAnchor, createRangeAnchor, reconcileAnchor } from "../../../src/review/core/anchors"
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
    const file: ReviewFile = {
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
    return file
  })
  const doc = createReviewDocument({
    identity,
    generation,
    commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }],
    files,
  })
  return doc
}

describe("conformance: core document and anchors", () => {
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    test(`${fixture.id}: document preserves file keys, hunk ranges, source, and stats`, () => {
      const doc = makeDocForFixture(fixture)
      expect(doc.files.length).toBe(fixture.expected.files.length)
      for (let i = 0; i < fixture.expected.files.length; i++) {
        const ef = fixture.expected.files[i]!
        const f = doc.files[i]!
        expect(f.key).toBe(ef.key)
        expect(f.path).toBe(ef.path)
        expect(f.kind).toBe(ef.kind)
        expect(f.source).toBe(ef.source)
        expect(f.stats).toEqual(ef.stats)
        if (ef.previousPath !== undefined) expect(f.previousPath).toBe(ef.previousPath)
        expect(f.hunks.length).toBe(ef.hunks.length)
        for (let hi = 0; hi < ef.hunks.length; hi++) {
          const eh = ef.hunks[hi]!
          const ah = f.hunks[hi]!
          expect(ah.oldStart).toBe(eh.oldStart)
          expect(ah.oldCount).toBe(eh.oldCount)
          expect(ah.newStart).toBe(eh.newStart)
          expect(ah.newCount).toBe(eh.newCount)
          expect([...ah.lines]).toEqual([...eh.lines])
        }
      }
      if (fixture.id === "empty") expect(doc.aggregatePatchDigest).toBe(sha256Tuple([]))
    })

    test(`${fixture.id}: contentId relationships (same vs distinct)`, () => {
      const doc = makeDocForFixture(fixture)
      const byKey = new Map(doc.files.map((f) => [f.key, f] as const))
      for (const [a, b] of fixture.expected.contentIdDistinctPairs) {
        const fa = byKey.get(a)
        const fb = byKey.get(b)
        if (!fa || !fb) continue
        expect(fa.contentId).not.toBe(fb.contentId)
      }
      for (const [a, b] of fixture.expected.contentIdSamePairs) {
        const fa = byKey.get(a)
        const fb = byKey.get(b)
        if (!fa || !fb) continue
        expect(fa.contentId).toBe(fb.contentId)
      }
    })

    test(`${fixture.id}: anchors map to source lines and reconcile as active`, () => {
      const doc = makeDocForFixture(fixture)
      if (doc.files.length === 0) return
      for (const ef of fixture.expected.files) {
        const file = doc.files.find((f) => f.key === ef.key)!
        expect(file).toBeDefined()
        const fileAnchor = createFileAnchor(file)
        const fileRecon = reconcileAnchor(fileAnchor, doc)
        expect(fileRecon.resolution).toBe("active")
        if (file.hunks.length > 0) {
          const h = file.hunks[0]!
          const useNew = h.newCount > 0
          const side = useNew ? "new" as const : "old" as const
          const line = useNew ? h.newStart : h.oldStart
          if (line < 1) continue
          const anchor = createRangeAnchor(file, { side, startLine: line, endLine: line })
          const recon = reconcileAnchor(anchor, doc)
          expect(recon.resolution).toBe("active")
          if (recon.resolution === "active" && recon.anchor.kind === "range") {
            expect(recon.anchor.fileKey).toBe(file.key)
            expect(recon.anchor.startLine).toBe(line)
          }
        }
      }
      if (fixture.id === "ambiguous-context") {
        const file = doc.files[0]!
        const anchor = createRangeAnchor(file, { side: "new", startLine: 4, endLine: 4 })
        expect(reconcileAnchor(anchor, doc).resolution).toBe("active")
      }
    })

    test(`${fixture.id}: gaps are addressable via fileKey + gapId`, () => {
      for (const g of fixture.expected.gaps) {
        const fileExists = fixture.expected.files.some((f) => f.key === g.fileKey)
        expect(fileExists).toBe(true)
        expect(g.gapId.startsWith("before:") || g.gapId.startsWith("trailing:")).toBe(true)
      }
    })
  }
})

import { parseReviewPatch } from "../src/review/git/patch-adapter"
import { createReviewDocument, createReviewHunk } from "../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../src/review/core/identity"
import { REVIEW_CONFORMANCE_FIXTURES, computeContentId, normalizedHunkBodyForFixture } from "../tests/review/conformance/corpus"

function measure<T>(fn: () => T): { result: T; elapsedMs: number; heapDelta: number; fixtureSize: number } {
  const beforeHeap = process.memoryUsage().heapUsed
  const start = performance.now()
  const result = fn()
  const elapsedMs = performance.now() - start
  const afterHeap = process.memoryUsage().heapUsed
  return { result, elapsedMs, heapDelta: afterHeap - beforeHeap, fixtureSize: 0 }
}

function buildDocumentForFixture(fixture: (typeof REVIEW_CONFORMANCE_FIXTURES)[number]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const parsed = parseReviewPatch(fixture.patch)
  const files = parsed.map((pf) => {
    const raw = fixture.rawEntries.find((r) => r.path === pf.path)
    const numstat = fixture.numstatEntries.find((n) => n.path === pf.path)
    const ef = fixture.expected.files.find((e) => e.path === pf.path)
    const normalizedBody = ef ? normalizedHunkBodyForFixture(ef) : pf.hunks.flatMap((h) => h.lines).join("\n") + (pf.hunks.length > 0 ? "\n" : "")
    const contentId = raw ? computeContentId(raw, normalizedBody) : sha256Tuple(["", "", "", "", normalizedBody])
    return {
      key: pf.path,
      path: pf.path,
      ...(pf.previousPath ? { previousPath: pf.previousPath } : {}),
      kind: (raw?.status?.startsWith("R") ? "renamed" : raw?.status?.startsWith("C") ? "copied" : pf.isBinary ? "binary" : raw?.status === "D" ? "deleted" : "modified") as any,
      oldBlobOid: raw?.oldBlobOid ?? null,
      newBlobOid: raw?.newBlobOid ?? null,
      oldMode: raw?.oldMode ?? null,
      newMode: raw?.newMode ?? null,
      contentId,
      patchDigest: pf.patchDigest,
      stats: { additions: numstat?.additions ?? null, deletions: numstat?.deletions ?? null },
      hunks: pf.hunks as any,
      source: pf.isBinary ? "binary" as const : "available" as const,
    }
  })
  // Fallback for fixtures like mode-only where parser returns 0 but expected has 1 file (no patch)
  // Synthesize from expected if parsed empty but expected non-empty
  if (files.length === 0 && fixture.expected.files.length > 0) {
    for (const ef of fixture.expected.files) {
      const raw = fixture.rawEntries.find((r) => r.path === ef.path)!
      const body = normalizedHunkBodyForFixture(ef)
      const contentId = computeContentId(raw, body)
      const hunks = ef.hunks.map((h) => createReviewHunk({ index: h.index, oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart, newCount: h.newCount, lines: [...h.lines] }))
      files.push({
        key: ef.key,
        path: ef.path,
        ...(ef.previousPath ? { previousPath: ef.previousPath } : {}),
        kind: ef.kind,
        oldBlobOid: raw.oldBlobOid,
        newBlobOid: raw.newBlobOid,
        oldMode: raw.oldMode,
        newMode: raw.newMode,
        contentId,
        patchDigest: sha256Tuple([body]),
        stats: ef.stats,
        hunks: hunks as any,
        source: ef.source,
      } as any)
    }
  }
  return createReviewDocument({ identity, generation, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files: files as any })
}

async function main() {
  const totalPatchSize = REVIEW_CONFORMANCE_FIXTURES.reduce((acc, f) => acc + f.patch.length, 0)
  const beforeHeap = process.memoryUsage().heapUsed
  const start = performance.now()
  let totalFiles = 0
  let totalHunks = 0
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    const doc = buildDocumentForFixture(fixture)
    totalFiles += doc.files.length
    for (const f of doc.files) totalHunks += f.hunks.length
  }

  // Large synthetic document: 500 files
  const largeIdentity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const largeGen = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  const largeFiles = Array.from({ length: 500 }, (_, i) => ({
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
  const largeDoc = createReviewDocument({ identity: largeIdentity, generation: largeGen, commits: [{ oid: "c".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files: largeFiles })
  const elapsedMs = performance.now() - start
  const heapDelta = process.memoryUsage().heapUsed - beforeHeap
  const output = {
    benchmark: "review-document-load",
    fixtureSize: totalPatchSize,
    fixtureCount: REVIEW_CONFORMANCE_FIXTURES.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    heapDeltaBytes: heapDelta,
    heapDeltaMiB: Math.round((heapDelta / 1024 / 1024) * 100) / 100,
    outputCount: { files: totalFiles, hunks: totalHunks, largeFiles: largeDoc.files.length },
  }
  console.log(JSON.stringify(output, null, 2))
  // sanity
  if (totalFiles === 0) {
    console.error("no files produced")
    process.exit(1)
  }
}

await main()

import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { coverageForFile, reviewProgress } from "../../../src/review/core/selectors"
import { planReviewIntent } from "../../../src/review/core/intents"
import { reduceReviewState } from "../../../src/review/core/reducer"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
}
function makeGeneration(id = "g1") {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" })
}
function file(overrides: { path: string; previousPath?: string; contentId: string; key?: string }): ReviewFile {
  const key = overrides.key ?? overrides.path
  return {
    key,
    path: overrides.path,
    ...(overrides.previousPath ? { previousPath: overrides.previousPath } : {}),
    kind: overrides.previousPath ? "renamed" : "modified",
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: overrides.contentId,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [],
    source: "available",
  } as unknown as ReviewFile
}
function makeDoc(files: ReviewFile[]): ReviewDocument {
  return createReviewDocument({ identity: makeIdentity(), generation: makeGeneration(), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" }] as any, files })
}

describe("coverageForFile path plus content identity", () => {
  test("path and contentId both decide validity", () => {
    const viewed = { fileKey: "src/a.ts", path: "src/a.ts", contentId: "content-1", generationId: "g1", viewedAt: "2026-08-27T00:00:00.000Z" }
    expect(coverageForFile(file({ path: "src/a.ts", contentId: "content-1" }), viewed)).toBe("viewed")
    expect(coverageForFile(file({ path: "src/b.ts", previousPath: "src/a.ts", contentId: "content-1" }), viewed)).toBe("changed-after-review")
    expect(coverageForFile(file({ path: "src/a.ts", contentId: "content-2" }), viewed)).toBe("changed-after-review")
  })

  test("no record is not-viewed, selected becomes reviewing", () => {
    const f = file({ path: "src/a.ts", contentId: "c1" })
    expect(coverageForFile(f, undefined)).toBe("not-viewed")
    expect(coverageForFile(f, undefined, "src/a.ts")).toBe("reviewing")
    expect(coverageForFile(f, {}, "src/a.ts")).toBe("reviewing")
    // changed-after-review takes precedence over reviewing when record mismatched
    const viewed = { fileKey: "src/a.ts", path: "src/a.ts", contentId: "content-1", generationId: "g1", viewedAt: "2026-08-27T00:00:00.000Z" }
    const changed = file({ path: "src/a.ts", contentId: "content-2" })
    expect(coverageForFile(changed, viewed, "src/a.ts")).toBe("changed-after-review")
  })

  test("map lookup uses fileKey", () => {
    const f1 = file({ path: "src/a.ts", contentId: "c1" })
    const f2 = file({ path: "src/b.ts", contentId: "c2" })
    const viewedMap = {
      "src/a.ts": { fileKey: "src/a.ts", path: "src/a.ts", contentId: "c1", generationId: "g1", viewedAt: "2026-08-27T00:00:00.000Z" },
    }
    expect(coverageForFile(f1, viewedMap)).toBe("viewed")
    expect(coverageForFile(f2, viewedMap)).toBe("not-viewed")
    expect(coverageForFile(f2, viewedMap, "src/b.ts")).toBe("reviewing")
  })

  test("generation is provenance only - does not decide validity", () => {
    const viewed = { fileKey: "src/a.ts", path: "src/a.ts", contentId: "c1", generationId: "old-gen", viewedAt: "2026-08-27T00:00:00.000Z" }
    // generation differs but path+content equal -> still viewed (generation ignored)
    expect(coverageForFile(file({ path: "src/a.ts", contentId: "c1" }), viewed)).toBe("viewed")
  })
})

describe("reviewProgress without scanning patch text", () => {
  test("counts totals from derived coverage", () => {
    const f1 = file({ path: "src/a.ts", contentId: "c1" })
    const f2 = file({ path: "src/b.ts", contentId: "c2" })
    const f3 = file({ path: "src/c.ts", contentId: "c3" })
    const doc = makeDoc([f1, f2, f3])
    const state = createInitialReviewState(doc)
    // mark f1 viewed
    const s1 = reduceReviewState(state, planReviewIntent(state, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: "2026-08-27T00:00:00.000Z" }))
    const prog = reviewProgress(s1)
    expect(prog.total).toBe(3)
    expect(prog.viewed).toBe(1)
    expect(prog.pending).toBe(0)
    // selecting f2 (not viewed) should count reviewing
    const s2 = reduceReviewState(s1, planReviewIntent(s1, { type: "selection/select-file", fileKey: "src/b.ts" }))
    const prog2 = reviewProgress(s2)
    expect(prog2.reviewing).toBe(1)
    expect(prog2.unreviewed).toBe(1) // f3 is unreviewed and not selected
    expect(prog2.changed).toBe(0)
  })

  test("changed-after-review after content change", () => {
    const f1 = file({ path: "src/a.ts", contentId: "c1" })
    const doc = makeDoc([f1])
    const s0 = createInitialReviewState(doc)
    const s1 = reduceReviewState(s0, planReviewIntent(s0, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: "2026-08-27T00:00:00.000Z" }))
    // simulate reconciled document where same path but new content
    const f1changed = file({ path: "src/a.ts", contentId: "c2" })
    const doc2 = createReviewDocument({ identity: makeIdentity(), generation: createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h2" }), commits: [{ oid: "c1", parents: [], author: "a", timestamp: 1, subject: "s", body: "" }] as any, files: [f1changed] })
    // Import reconcile to test? For progress we can manually check coverage
    expect(coverageForFile(f1changed, s1.viewed)).toBe("changed-after-review")
    const s1withNewDoc = { ...s1, document: doc2 } as any
    const prog = reviewProgress(s1withNewDoc)
    expect(prog.changed).toBe(1)
    expect(prog.viewed).toBe(0)
  })
})

describe("marking Viewed stores file key, path, content id, generation id, and timestamp", () => {
  test("aggregate marking succeeds", () => {
    const f = file({ path: "src/a.ts", contentId: "c1" })
    const doc = makeDoc([f])
    const s0 = createInitialReviewState(doc)
    expect(s0.projection.kind).toBe("aggregate")
    const action = planReviewIntent(s0, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: "2026-08-27T00:00:00.000Z" })
    expect(action.type).toBe("viewed/mark")
    const s1 = reduceReviewState(s0, action)
    expect(s1.viewed["src/a.ts"]).toEqual({
      fileKey: "src/a.ts",
      path: "src/a.ts",
      contentId: "c1",
      generationId: s0.document.generation.id,
      viewedAt: "2026-08-27T00:00:00.000Z",
    })
    expect(coverageForFile(f, s1.viewed)).toBe("viewed")
  })

  test("commit projection refuses marking", () => {
    const f = file({ path: "src/a.ts", contentId: "c1" })
    const doc = makeDoc([f])
    const s0 = createInitialReviewState(doc)
    const sAgg = s0
    // set projection to commit
    const sCommit = reduceReviewState(sAgg, planReviewIntent(sAgg, { type: "projection/set", projection: { kind: "commit", oid: "c1" } }))
    expect(sCommit.projection.kind).toBe("commit")
    expect(() => planReviewIntent(sCommit, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: "2026-08-27T00:00:00.000Z" })).toThrow()
  })

  test("since-last-review eligibility is projection-specific", () => {
    const f = file({ path: "src/a.ts", contentId: "c1" })
    const doc = makeDoc([f])
    const s0 = createInitialReviewState(doc)
    // since-last-review requires a submitted head that is ancestor; we test that projection/set validates existence
    // For now, allow marking in since-last-review if file exists; commit already tested refusal.
    const sSince = reduceReviewState(s0, planReviewIntent(s0, { type: "projection/set", projection: { kind: "since-last-review", fromHeadOid: "c1" } }))
    expect(sSince.projection.kind).toBe("since-last-review")
    // Marking in since-last-review should be allowed (subject to future detailed checks)
    const action = planReviewIntent(sSince, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: "2026-08-27T00:00:00.000Z" })
    expect(action.type).toBe("viewed/mark")
  })
})

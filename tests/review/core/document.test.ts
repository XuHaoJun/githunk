import { describe, expect, test } from "bun:test"
import { createReviewDocument, indexReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewCommit, ReviewDocument, ReviewFile } from "../../../src/review/core/types"

function makeIdentity() {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
}
function makeGeneration() {
  return createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" })
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
  }
}
function makeCommit(overrides: Partial<ReviewCommit> & { oid: string }): ReviewCommit {
  return {
    parents: [],
    author: "Alice <alice@example.com>",
    timestamp: 1_700_000_000,
    subject: "subject",
    body: "",
    ...overrides,
  }
}

describe("review document invariants", () => {
  test("throws on duplicate file keys", () => {
    const identity = makeIdentity()
    const generation = makeGeneration()
    const file = makeFile({ key: "k1", path: "a.ts" })
    expect(() =>
      createReviewDocument({
        identity,
        generation,
        commits: [],
        files: [file, makeFile({ key: "k1", path: "b.ts" })],
      }),
    ).toThrow(/duplicate file key/)
  })

  test("throws on duplicate file paths", () => {
    const identity = makeIdentity()
    const generation = makeGeneration()
    expect(() =>
      createReviewDocument({
        identity,
        generation,
        commits: [],
        files: [makeFile({ key: "k1", path: "a.ts" }), makeFile({ key: "k2", path: "a.ts" })],
      }),
    ).toThrow(/duplicate file path/)
  })

  test("throws on duplicate commit OIDs", () => {
    const identity = makeIdentity()
    const generation = makeGeneration()
    expect(() =>
      createReviewDocument({
        identity,
        generation,
        commits: [makeCommit({ oid: "c1" }), makeCommit({ oid: "c1" })],
        files: [],
      }),
    ).toThrow(/duplicate commit oid/)
  })

  test("builds readonly indexes for valid input", () => {
    const identity = makeIdentity()
    const generation = makeGeneration()
    const doc = createReviewDocument({
      identity,
      generation,
      commits: [makeCommit({ oid: "c1" }), makeCommit({ oid: "c2" })],
      files: [makeFile({ key: "k1", path: "a.ts" }), makeFile({ key: "k2", path: "b.ts" })],
    })
    const index = indexReviewDocument(doc)
    expect(index.fileByKey.get("k1")?.path).toBe("a.ts")
    expect(index.fileByKey.get("k2")?.path).toBe("b.ts")
    expect(index.fileIndexByKey.get("k1")).toBe(0)
    expect(index.fileIndexByKey.get("k2")).toBe(1)
    expect(index.commitByOid.get("c1")?.oid).toBe("c1")
    expect(index.commitByOid.get("c2")?.oid).toBe("c2")
  })

  test("indexReviewDocument throws on duplicate keys in raw document", () => {
    const identity = makeIdentity()
    const generation = makeGeneration()
    const doc = {
      identity,
      generation,
      commits: [],
      files: [makeFile({ key: "k1", path: "a.ts" }), makeFile({ key: "k1", path: "b.ts" })],
      aggregatePatchDigest: "x",
    } as unknown as ReviewDocument
    expect(() => indexReviewDocument(doc)).toThrow(/duplicate file key/)
  })
})

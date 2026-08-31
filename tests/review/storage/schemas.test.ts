import { describe, expect, test } from "bun:test"
import {
  emptyReviewDatabaseV2,
  parseReviewArtifactV1,
  parseReviewDatabaseV2,
  serializeReviewArtifactV1,
  serializeReviewDatabaseV2,
} from "../../../src/review/storage/schemas"
import type { ReviewArtifactV1 } from "../../../src/review/core/artifact"

function makeValidDatabase(): ReturnType<typeof emptyReviewDatabaseV2> & { baseByHead: Record<string, { baseRef: string }>; reviews: Record<string, any> } {
  const reviewId = "abc123"
  return {
    version: 2,
    baseByHead: {
      "refs/heads/feature": { baseRef: "refs/heads/main" },
      "detached:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { baseRef: "refs/heads/main" },
    },
    reviews: {
      [reviewId]: {
        selection: { fileKey: null, hunkIndex: 0 },
        filter: { query: "", scope: "all" },
        projection: { kind: "aggregate" },
        viewed: {
          "file-a": { fileKey: "file-a", path: "src/a.ts", contentId: "cid1", generationId: "gen1", viewedAt: new Date().toISOString() },
        },
        feedback: [
          {
            id: "fb1",
            kind: "note",
            severity: "comment",
            body: "hello",
            anchor: { kind: "file", fileKey: "file-a", contentId: "cid1" },
            resolution: "active",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        draft: null,
        expandedGaps: [{ fileKey: "file-a", gapId: "gap1", expanded: true }],
        lastSubmission: null,
        submissionInProgress: null,
      },
    },
  }
}

function makeValidArtifact(): ReviewArtifactV1 {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: "artifact-1",
    review: { id: "review1", headRef: "refs/heads/feature", baseRef: "refs/heads/main", detachedHeadOid: null },
    generation: { id: "gen1", baseOid: "a".repeat(40), mergeBaseOid: "b".repeat(40), headOid: "c".repeat(40) },
    submittedAt: now,
    decision: "approve",
    summary: "looks good",
    projection: { kind: "aggregate" },
    coverage: {
      viewed: [{ fileKey: "k1", path: "a.ts", contentId: "cid1" }],
      notViewed: [{ fileKey: "k2", path: "b.ts" }],
    },
    feedback: [
      {
        id: "fb1",
        kind: "note",
        severity: "comment",
        body: "nice",
        anchor: { kind: "file", fileKey: "k1", contentId: "cid1" },
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
}

describe("schemas – round trips", () => {
  test("valid database round trip", () => {
    const db = makeValidDatabase()
    const text = serializeReviewDatabaseV2(db as any)
    const parsed = parseReviewDatabaseV2(JSON.parse(text))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.version).toBe(2)
      expect(parsed.value.baseByHead["refs/heads/feature"]?.baseRef).toBe("refs/heads/main")
    }
  })

  test("valid artifact round trip", () => {
    const artifact = makeValidArtifact()
    const text = serializeReviewArtifactV1(artifact)
    const parsed = parseReviewArtifactV1(JSON.parse(text))
    expect(parsed.ok).toBe(true)
  })
})
  test("retains deferred projection metadata for the active boundary to normalize", () => {
    const db = makeValidDatabase()
    db.reviews["abc123"].projection = { kind: "commit", oid: "c".repeat(40) }
    const parsed = parseReviewDatabaseV2(db)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.reviews["abc123"]?.projection).toEqual({ kind: "commit", oid: "c".repeat(40) })
  })

describe("schemas – rejected unknown versions", () => {
  test("rejects version 3 database", () => {
    const db = { ...makeValidDatabase(), version: 3 } as any
    const result = parseReviewDatabaseV2(db)
    expect(result.ok).toBe(false)
  })

  test("rejects version 0", () => {
    const db = { ...makeValidDatabase(), version: 0 } as any
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects v1 read (version 1)", () => {
    const v1: any = { version: 1, baseByBranch: {}, targets: {} }
    expect(parseReviewDatabaseV2(v1).ok).toBe(false)
  })

  test("rejects unknown artifact version 2", () => {
    const artifact = { ...makeValidArtifact(), version: 2 } as any
    expect(parseReviewArtifactV1(artifact).ok).toBe(false)
  })
})

describe("schemas – rejected invalid ranges/decisions/timestamps", () => {
  test("rejects invalid range – endLine < startLine", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].feedback = [
      {
        id: "fb2",
        kind: "note",
        severity: "comment",
        body: "x",
        anchor: { kind: "range", fileKey: "file-a", contentId: "cid1", side: "new", startLine: 10, endLine: 5, ownerHunkIndex: 0, contextDigest: "d" },
        resolution: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects invalid range – startLine 0", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].feedback[0].anchor = { kind: "range", fileKey: "file-a", contentId: "cid1", side: "new", startLine: 0, endLine: 1, ownerHunkIndex: 0, contextDigest: "d" }
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects invalid decision", () => {
    const artifact: any = makeValidArtifact()
    artifact.decision = "invalid-decision" as any
    expect(parseReviewArtifactV1(artifact).ok).toBe(false)
  })

  test("rejects invalid timestamp", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].viewed["file-a"].viewedAt = "not-a-timestamp"
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects invalid suggestion without replacement", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].feedback = [
      {
        id: "fb3",
        kind: "suggestion",
        severity: "blocking",
        body: "should fix",
        anchor: { kind: "range", fileKey: "file-a", contentId: "cid1", side: "new", startLine: 1, endLine: 2, ownerHunkIndex: 0, contextDigest: "d" },
        resolution: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects suggestion with old side", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].feedback = [
      {
        id: "fb4",
        kind: "suggestion",
        severity: "blocking",
        body: "fix",
        replacement: "new content",
        anchor: { kind: "range", fileKey: "file-a", contentId: "cid1", side: "old", startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: "d" },
        resolution: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })
})

describe("schemas – detached baseByHead keys", () => {
  test("accepts valid detached key", () => {
    const db: any = makeValidDatabase()
    db.baseByHead = { "detached:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { baseRef: "refs/heads/main" } }
    expect(parseReviewDatabaseV2(db).ok).toBe(true)
  })

  test("rejects invalid detached key with short oid", () => {
    const db: any = makeValidDatabase()
    db.baseByHead = { "detached:short": { baseRef: "refs/heads/main" } }
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects detached key with invalid hex", () => {
    const db: any = makeValidDatabase()
    db.baseByHead = { "detached:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz": { baseRef: "refs/heads/main" } }
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects baseByHead key containing colon not detached", () => {
    const db: any = makeValidDatabase()
    db.baseByHead = { "invalid:key": { baseRef: "refs/heads/main" } }
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("accepts normal head ref keys", () => {
    const db: any = makeValidDatabase()
    db.baseByHead = { "refs/heads/my-feature": { baseRef: "refs/heads/main" }, "feature/x": { baseRef: "refs/heads/main" } }
    expect(parseReviewDatabaseV2(db).ok).toBe(true)
  })
})

describe("schemas – exclusion of raw patches/renderer fields", () => {
  test("rejects extra patch field on feedback", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].feedback[0].patch = "diff --git a/a b/a"
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects extra renderer field on viewed", () => {
    const db: any = makeValidDatabase()
    db.reviews["abc123"].viewed["file-a"].rendererRows = []
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects extra field on top-level database", () => {
    const db: any = makeValidDatabase()
    db.extra = true
    expect(parseReviewDatabaseV2(db).ok).toBe(false)
  })

  test("rejects raw patch on artifact coverage", () => {
    const artifact: any = makeValidArtifact()
    artifact.coverage.viewed[0].patch = "raw"
    expect(parseReviewArtifactV1(artifact).ok).toBe(false)
  })
})

describe("schemas – no v1 artifact version", () => {
  test("does not accept artifact version 0", () => {
    const artifact: any = makeValidArtifact()
    artifact.version = 0
    expect(parseReviewArtifactV1(artifact).ok).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"

describe("review identity", () => {
  test("keeps one review id while HEAD and base OIDs move", () => {
    const first = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
    const second = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h2", baseRef: "refs/remotes/origin/main" })
    expect(second.id).toBe(first.id)
    expect(createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" }).id)
      .not.toBe(createReviewGeneration({ mergeBaseOid: "m2", baseOid: "b2", headOid: "h2" }).id)
  })

  test("uses the detached OID as snapshot identity", () => {
    const identity = createReviewIdentity({ headOid: "deadbeef", baseRef: "main" })
    expect(identity).toMatchObject({ headRef: null, detachedHeadOid: "deadbeef" })
  })
})

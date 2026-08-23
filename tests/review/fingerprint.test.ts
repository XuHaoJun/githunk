import { describe, expect, test } from "bun:test"
import { fingerprintFile, sha256Tuple, targetKey } from "../../src/review/fingerprint"
import type { ReviewTarget } from "../../src/domain/review-target"

describe("review fingerprints", () => {
  const target: ReviewTarget = { kind: "working-tree", scope: "all" }
  test("is stable and distinguishes length-prefixed fields", () => {
    const first = fingerprintFile(target, { currentPath: "a|b", previousPath: undefined, rawPatch: "patch" })
    const second = fingerprintFile(target, { currentPath: "a", previousPath: undefined, rawPatch: "b|patch" })
    expect(first).not.toBe(second)
    expect(first).toBe(fingerprintFile(target, { currentPath: "a|b", rawPatch: "patch" }))
    expect(sha256Tuple(["a|b", "c"])).not.toBe(sha256Tuple(["a", "b|c"]))
  })

  test("includes branch base and head OIDs in target identity", () => {
    const first = targetKey({ kind: "branch", baseRef: "origin/main", baseOid: "base-1", headOid: "head-1" })
    const second = targetKey({ kind: "branch", baseRef: "origin/main", baseOid: "base-1", headOid: "head-2" })
    expect(targetKey({ kind: "branch", baseRef: "refs/remotes/origin/main", baseOid: "base-1", headOid: "head-1" })).toBe(first)
    expect(first).not.toBe(second)
  })
})

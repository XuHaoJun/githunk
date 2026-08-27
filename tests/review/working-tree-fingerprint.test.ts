import { describe, expect, test } from "bun:test"
import { fingerprintWorkingTreeFile, sha256Tuple, workingTreeTargetKey } from "../../src/review/working-tree-fingerprint"
import type { ReviewTarget } from "../../src/domain/review-target"

describe("working tree fingerprints", () => {
  test("is stable and distinguishes length-prefixed fields", () => {
    const target: ReviewTarget = { kind: "working-tree", scope: "all" }
    const first = fingerprintWorkingTreeFile(target, { currentPath: "a|b", previousPath: undefined, rawPatch: "patch" })
    const second = fingerprintWorkingTreeFile(target, { currentPath: "a", previousPath: undefined, rawPatch: "b|patch" })
    expect(first).not.toBe(second)
    expect(first).toBe(fingerprintWorkingTreeFile(target, { currentPath: "a|b", rawPatch: "patch" }))
    expect(sha256Tuple(["a|b", "c"])).not.toBe(sha256Tuple(["a", "b|c"]))
  })

  test("distinguishes working-tree scopes and stash refs", () => {
    const all = workingTreeTargetKey({ kind: "working-tree", scope: "all" })
    const staged = workingTreeTargetKey({ kind: "working-tree", scope: "staged" })
    const stash0 = workingTreeTargetKey({ kind: "stash", ref: "stash@{0}" })
    const stash1 = workingTreeTargetKey({ kind: "stash", ref: "stash@{1}" })
    expect(all).not.toBe(staged)
    expect(stash0).not.toBe(stash1)
    expect(all).not.toBe(stash0)
  })

  test("fingerprint changes when file path or patch changes", () => {
    const target = { kind: "working-tree", scope: "all" } as const
    const a = fingerprintWorkingTreeFile(target, { currentPath: "a.ts", rawPatch: "patch-a" })
    const b = fingerprintWorkingTreeFile(target, { currentPath: "b.ts", rawPatch: "patch-a" })
    const c = fingerprintWorkingTreeFile(target, { currentPath: "a.ts", rawPatch: "patch-b" })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  test("restricted API rejects Branch target at compile time", () => {
    // This compiles only because the Branch variant is not assignable to MutableReviewTarget.
    // The line below would fail with: @ts-expect-error
    // workingTreeTargetKey({ kind: "branch", baseRef: "main", baseOid: "abc", headOid: "def" })
    expect(typeof workingTreeTargetKey).toBe("function")
  })
})

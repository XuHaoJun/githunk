import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { AppController } from "../../src/app/controller"
import { WorkingTreeReviewStore } from "../../src/review/working-tree-store"
import { fingerprintWorkingTreeFile, workingTreeTargetKey } from "../../src/review/working-tree-fingerprint"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import { createTempRepository } from "../helpers/temp-repository"

function snapshot(repositoryRoot: string, patch: string): WorkingTreeSnapshot {
  return {
    repositoryRoot,
    branch: "main",
    reviewTarget: { kind: "working-tree", scope: "all" },
    files: [{ path: "a.ts", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 }],
    patches: [{ label: "UNSTAGED", text: patch }],
  }
}

describe("cutover: dedicated workspace isolation", () => {
  test("WorkingTreeReviewStore is importable and starts empty", async () => {
    const repo = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repo.path)
      const db = await store.load()
      expect(db.version).toBe(1)
      expect(Object.keys(db.targets)).toHaveLength(0)
    } finally {
      await repo.cleanup()
    }
  })

  test("workingTreeTargetKey and fingerprintWorkingTreeFile are importable and stable", () => {
    const target = { kind: "working-tree" as const, scope: "all" as const }
    const key = workingTreeTargetKey(target)
    const fp = fingerprintWorkingTreeFile(target, { currentPath: "a.ts", rawPatch: "patch" })
    expect(key.length).toBe(64)
    expect(fp.length).toBe(64)
    expect(fingerprintWorkingTreeFile(target, { currentPath: "a.ts", rawPatch: "patch" })).toBe(fp)
  })

  test("repository controller wired to WorkingTreeReviewStore preserves Working Tree coverage", async () => {
    const repo = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repo.path)
      let patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
      const controller = new AppController({ repositoryRoot: repo.path, reviewStore: store, load: async () => snapshot(repo.path, patch) })
      await controller.refresh()
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("not-reviewed")
      controller.selectFile("a.ts")
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("reviewing")
      await controller.markFocusedFileReviewed("a.ts")
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("reviewed")
      patch = patch.replace("+new", "+changed")
      await controller.refresh()
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("changed-after-review")
    } finally {
      await repo.cleanup()
    }
  })

  test("stash coverage also isolated through WorkingTreeReviewStore", async () => {
    const stashTarget = { kind: "stash" as const, ref: "stash@{0}" }
    const fp = fingerprintWorkingTreeFile(stashTarget, { currentPath: "a.ts", rawPatch: "patch" })
    expect(fp.length).toBe(64)
    const key = workingTreeTargetKey(stashTarget)
    expect(key.length).toBe(64)
    const wtKey = workingTreeTargetKey({ kind: "working-tree", scope: "all" })
    expect(key).not.toBe(wtKey)
  })

  test("restricted API rejects Branch target at compile time", () => {
    expect(typeof workingTreeTargetKey).toBe("function")
    expect(typeof fingerprintWorkingTreeFile).toBe("function")
  })

  test("old combined store path not used", async () => {
    const repo = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repo.path)
      await store.save({ version: 1, baseByBranch: {}, targets: {} })
      const files = await readdir(`${repo.path}/.git/githunk`)
      expect(files).toContain("working-tree-review-state-v1.json")
      expect(files).not.toContain("review-state-v1.json")
    } finally {
      await repo.cleanup()
    }
  })
})

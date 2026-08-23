import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import { ReviewStore } from "../../src/review/store"
import { fingerprintFile } from "../../src/review/fingerprint"
import { createTempRepository } from "../helpers/temp-repository"

function snapshot(repositoryRoot: string, patch: string, files = [{ path: "a.ts", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 }]): WorkingTreeSnapshot {
  return {
    repositoryRoot,
    branch: "main",
    reviewTarget: { kind: "working-tree", scope: "all" },
    files,
    patches: [{ label: "UNSTAGED", text: patch }],
  }
}

describe("review invalidation", () => {
  test("reviewed working-tree content becomes changed-after-review after refresh", async () => {
    const repository = await createTempRepository()
    try {
      const store = new ReviewStore(repository.path)
      let patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
      const controller = new AppController({ repositoryRoot: repository.path, reviewStore: store, load: async () => snapshot(repository.path, patch) })
      await controller.refresh()
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("not-reviewed")
      controller.selectFile("a.ts")
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("reviewing")
      await controller.markFocusedFileReviewed("a.ts")
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("reviewed")
      expect(controller.state.reviewSummary?.reviewed).toBe(1)
      patch = patch.replace("+new", "+changed")
      await controller.refresh()
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("changed-after-review")
      const restarted = new AppController({ repositoryRoot: repository.path, reviewStore: new ReviewStore(repository.path), load: async () => snapshot(repository.path, patch) })
      await restarted.refresh()
      expect(restarted.state.reviewStatuses?.["a.ts"]).toBe("changed-after-review")
      expect(fingerprintFile(controller.state.reviewTarget, { currentPath: "a.ts", rawPatch: patch })).not.toBe("")
    } finally {
      await repository.cleanup()
    }
  })
  test("marks the stable focused path after files reorder", async () => {
    const repository = await createTempRepository()
    try {
      const files = [
        { path: "a.ts", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 },
        { path: "b.ts", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 },
      ]
      const patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+a\ndiff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-b\n+b\n"
      let current = files
      const controller = new AppController({
        repositoryRoot: repository.path,
        reviewStore: new ReviewStore(repository.path),
        load: async () => snapshot(repository.path, patch, current),
      })
      await controller.refresh()
      controller.selectFile("a.ts")
      current = [files[1]!, files[0]!]
      await controller.refresh()
      await controller.markFocusedFileReviewed()
      expect(controller.state.reviewStatuses?.["a.ts"]).toBe("reviewed")
      expect(controller.state.reviewStatuses?.["b.ts"]).toBe("not-reviewed")
    } finally {
      await repository.cleanup()
    }
  })
})

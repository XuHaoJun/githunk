import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import type { BranchReviewSnapshot } from "../../src/git/branch-review"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import type { CommitDetails } from "../../src/domain/commit"

function workingSnapshot(scope: "all" | "staged" | "unstaged"): WorkingTreeSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    reviewTarget: { kind: "working-tree", scope },
    files: [{ path: "working.txt", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 }],
    patches: [{ label: "UNSTAGED", text: "diff --git a/working.txt b/working.txt\n" }],
  }
}

function branchSnapshot(baseRef: string): BranchReviewSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    baseRef,
    baseOid: "base-oid",
    headOid: "head-oid",
    mergeBaseOid: "base-oid",
    commitCount: 3,
    reviewTarget: { kind: "branch", baseRef, baseOid: "base-oid", headOid: "head-oid" },
    files: [{ path: "branch.txt", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 3, deletions: 0 }],
    patches: [{ label: "BRANCH", text: "diff --git a/branch.txt b/branch.txt\n" }],
  }
}

describe("AppController branch mode", () => {
  test("switches modes with separate cursor state and aggregate commit count", async () => {
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident", ref: "origin/main", oid: "base-oid", reason: "test" }),
    })

    await controller.refresh()
    controller.selectFile("working.txt")
    await controller.switchMode("branch")
    expect(controller.state.title).toBe("main vs origin/main")
    expect(controller.state.reviewSummary?.commits).toBe(3)
    controller.selectFile("branch.txt")
    await controller.switchMode("working-tree")
    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    expect(controller.state.focusId).toBe("working.txt")
    await controller.switchMode("branch")
    expect(controller.state.focusId).toBe("branch.txt")
  })
  test("clears Working Tree focus on first Branch switch", async () => {
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident", ref: "origin/main", oid: "base-oid", reason: "test" }),
    })
    await controller.refresh()
    controller.selectFile("working.txt")
    await controller.switchMode("branch")
    expect(controller.state.focusId).toBeUndefined()
    expect(controller.state.selectionId).toBeUndefined()
  })

  test("keeps aggregate commit count when marking a Branch file reviewed", async () => {
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident", ref: "origin/main", oid: "base-oid", reason: "test" }),
    })
    await controller.switchMode("branch")
    await controller.markFileReviewed("branch.txt")
    expect(controller.state.reviewSummary?.commits).toBe(3)
  })

  test("does not invoke mutations in Branch Review", async () => {
    let stages = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident", ref: "origin/main", oid: "base-oid", reason: "test" }),
      mutations: { stageFile: async () => { stages += 1 } } as never,
    })
    await controller.switchMode("branch")
    await controller.stageFile("branch.txt")
    expect(stages).toBe(0)
    expect(controller.state.banner).toBe("Branch Review is read-only")
  })

  test("does not persist an inferred base when Branch loading fails", async () => {
    let saves = 0
    const reviewStore = {
      async load() { return { version: 1 as const, baseByBranch: {}, targets: {} } },
      async save() { saves += 1 },
    }
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      reviewStore: reviewStore as never,
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async () => { throw new Error("merge-base failed") },
      inferBase: async () => ({ kind: "confident", ref: "origin/main", oid: "base-oid", reason: "test" }),
    })
    await controller.refresh()
    await controller.switchMode("branch")
    expect(saves).toBe(0)
    expect(controller.state.banner).toBe("merge-base failed")
  })

  test("revalidates the base when the open Branch Review is refreshed", async () => {
    let inference = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => {
        inference += 1
        return { kind: "confident" as const, ref: inference === 1 ? "origin/main" : "origin/release", oid: "base-oid", reason: "test" }
      },
    })
    await controller.switchMode("branch")
    expect(controller.state.reviewTarget.kind === "branch" ? controller.state.reviewTarget.baseRef : "").toBe("origin/main")
    await controller.refresh()
    expect(controller.state.reviewTarget.kind === "branch" ? controller.state.reviewTarget.baseRef : "").toBe("origin/release")
  })
  test("keeps a ReviewStore corruption warning after confident Branch load", async () => {
    const reviewStore = {
      warning: "review state was quarantined",
      async load() { return { version: 1 as const, baseByBranch: {}, targets: {} } },
      async save() {},
    }
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      reviewStore: reviewStore as never,
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident" as const, ref: "origin/main", oid: "base-oid", reason: "test" }),
    })
    await controller.switchMode("branch")
    expect(controller.state.banner).toBe("review state was quarantined")
  })
  test("inspects commits for the selected local or remote branch", async () => {
    const seenRanges: string[] = []
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadCommits: async (range) => {
        seenRanges.push(range)
        return []
      },
    })
    await controller.inspectBranch("feature/local")
    await controller.inspectBranch("origin/feature/remote")
    expect(seenRanges).toEqual(["feature/local", "origin/feature/remote"])
  })
  test("uses the inspected branch as commit origin when returning from a commit", async () => {
    const seenBases: string[] = []
    const details: CommitDetails = {
      oid: "commit-1",
      shortOid: "commit",
      parentOids: ["parent"],
      authorName: "A",
      authoredAt: "2026-01-01T00:00:00Z",
      subject: "one",
      body: "",
      document: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [] },
      patch: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [] },
      raw: "",
    }
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => workingSnapshot(target.scope),
      loadBranch: async (baseRef) => {
        seenBases.push(baseRef)
        return branchSnapshot(baseRef)
      },
      loadCommits: async () => [{ oid: "commit-1", shortOid: "commit", parentOids: ["parent"], authorName: "A", authoredAt: "2026-01-01T00:00:00Z", subject: "one", body: "" }],
      loadCommit: async () => details,
      inferBase: async () => ({ kind: "confident" as const, ref: "origin/main", oid: "base-oid", reason: "test" }),
    })
    await controller.switchMode("branch")
    await controller.inspectBranch("feature/local")
    const loaded = await controller.loadCommitInspection("commit-1")
    expect(loaded.oid).toBe("commit-1")
    expect(controller.state.reviewTarget.kind).not.toBe("commit")
    expect(seenBases).toContain("origin/main")
  })
})

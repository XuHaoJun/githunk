import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import type { BranchReviewSnapshot, } from "../../src/git/branch-review"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"

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
})

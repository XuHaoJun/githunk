import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository } from "../helpers/temp-repository"
import type { CommitDetails, CommitSummary } from "../../src/domain/commit"
import type { BranchReviewSnapshot } from "../../src/git/branch-review"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"

const commits: readonly CommitSummary[] = [
  { oid: "commit-1", shortOid: "commit", parentOids: ["parent"], authorName: "A", authoredAt: "2026-01-01T00:00:00Z", subject: "one", body: "" },
]
const details: CommitDetails = {
  ...commits[0]!,
  document: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [] },
  patch: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [] },
  raw: "",
}
const working: WorkingTreeSnapshot = {
  repositoryRoot: "/tmp/repo", branch: "main", reviewTarget: { kind: "working-tree", scope: "all" }, files: [], patches: [],
}
const branch: BranchReviewSnapshot = {
  repositoryRoot: "/tmp/repo", branch: "main", baseRef: "main~1", baseOid: "base", headOid: "head", mergeBaseOid: "base", commitCount: 1,
  reviewTarget: { kind: "branch", baseRef: "main~1", baseOid: "base", headOid: "head" }, files: [], patches: [],
}

describe("commit drill-down controller", () => {
  test("keeps aggregate Branch Review target and progress key while selecting a commit", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async () => details,
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const aggregate = controller.state.branchReviewTarget
    const aggregateKey = controller.state.reviewTarget.kind === "branch" ? `${controller.state.reviewTarget.baseOid}..${controller.state.reviewTarget.headOid}` : ""
    await controller.selectCommit("commit-1")
    expect(controller.state.reviewTarget).toEqual({ kind: "commit", oid: "commit-1" })
    expect(controller.state.branchReviewTarget).toEqual(aggregate)
    expect(aggregateKey).toBe("base..head")
  })
  test("resets commit drill-down after checking out another branch", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.git(["switch", "-c", "feature"])
      await repository.write("file.txt", "feature\n")
      await repository.git(["commit", "-am", "feature"])
      await repository.git(["switch", "-"])
      const runner = new GitRunner(repository.path)
      const inferredBranches: string[] = []
      const controller = new AppController({
        runner,
        load: async (target) => ({ ...working, reviewTarget: target }),
        loadBranch: async (baseRef) => {
          const current = (await repository.git(["branch", "--show-current"])).stdout.trim()
          return { ...branch, branch: current, baseRef, reviewTarget: { ...branch.reviewTarget, baseRef } }
        },
        loadCommit: async () => details,
        loadCommits: async () => commits,
        inferBase: async () => {
          inferredBranches.push((await repository.git(["branch", "--show-current"])).stdout.trim())
          return { kind: "confident" as const, ref: "HEAD~1", oid: "base", reason: "test" }
        },
      })
      await controller.switchMode("branch")
      await controller.selectCommit("commit-1")
      await controller.switchLocalBranch("feature")
      expect(controller.state.reviewTarget.kind).toBe("branch")
      expect(controller.state.branch).toBe("feature")
      expect(controller.state.commitDetails).toBeUndefined()
      expect(controller.state.commitFilePath).toBeUndefined()
      expect(inferredBranches.at(-1)).toBe("feature")
      expect(controller.state.title).not.toContain("commit-1")
    } finally {
      await repository.cleanup()
    }
  })
})

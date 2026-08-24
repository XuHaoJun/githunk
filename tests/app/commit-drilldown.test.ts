import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import type { BranchReviewSnapshot } from "../../src/git/branch-review"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import type { CommitDetails, CommitSummary } from "../../src/domain/commit"

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
})

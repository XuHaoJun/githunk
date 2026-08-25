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
  document: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [{ fileIndex: 0, oldPath: "a.txt", newPath: "a.txt", startUtf16: 0, endUtf16: 24, lines: [], hunks: [] }] },
  patch: { text: "diff --git a/a.txt b/a.txt\n", lines: [], files: [] },
  raw: "",
  preamble: "commit commit-1\nAuthor: A\n\n    one\n\n1 file changed",
}
const emptyDetails: CommitDetails = {
  ...commits[0]!,
  oid: "empty-commit",
  shortOid: "empty",
  document: { text: "", lines: [], files: [] },
  patch: { text: "", lines: [], files: [] },
  raw: "",
  preamble: "commit empty-commit\nAuthor: A\n\n    empty\n\n",
}
const working: WorkingTreeSnapshot = {
  repositoryRoot: "/tmp/repo", branch: "main", reviewTarget: { kind: "working-tree", scope: "all" }, files: [], patches: [],
}
const branch: BranchReviewSnapshot = {
  repositoryRoot: "/tmp/repo", branch: "main", baseRef: "main~1", baseOid: "base", headOid: "head", mergeBaseOid: "base", commitCount: 1,
  reviewTarget: { kind: "branch", baseRef: "main~1", baseOid: "base", headOid: "head" }, files: [], patches: [],
}

describe("commit drill-down controller", () => {
  test("loadCommitInspection is read-only and does not mutate reviewTarget or commit state", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async () => details,
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const target = controller.state.reviewTarget
    const branchTarget = controller.state.branchReviewTarget
    const result = await controller.loadCommitInspection("commit-1")
    expect(result.oid).toBe("commit-1")
    expect(controller.state.reviewTarget).toEqual(target)
    expect(controller.state.branchReviewTarget).toEqual(branchTarget)
    expect("commitDetails" in controller.state).toBe(false)
    expect("commitFilePath" in controller.state).toBe(false)
  })

  test("allow-empty commit has empty document files without changing state", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async (oid) => oid === "empty-commit" ? emptyDetails : details,
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const target = controller.state.reviewTarget
    const branchTarget = controller.state.branchReviewTarget
    const result = await controller.loadCommitInspection("empty-commit")
    expect(result.document.files).toHaveLength(0)
    expect(controller.state.reviewTarget).toEqual(target)
    expect(controller.state.branchReviewTarget).toEqual(branchTarget)
  })

  test("failed loadCommitInspection leaves prior state intact", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async () => { throw new Error("load failed") },
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const target = controller.state.reviewTarget
    const branchTarget = controller.state.branchReviewTarget
    await expect(controller.loadCommitInspection("commit-1")).rejects.toThrow("load failed")
    expect(controller.state.reviewTarget).toEqual(target)
    expect(controller.state.branchReviewTarget).toEqual(branchTarget)
  })

  test("loadCommitFileInspection does not mutate state", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async () => details,
      loadCommitFilePatch: async () => ({ text: "diff --git a/a.txt b/a.txt\n+line\n", lines: [], files: [] }),
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const target = controller.state.reviewTarget
    const doc = await controller.loadCommitFileInspection("commit-1", "a.txt")
    expect(doc.text).toContain("diff --git")
    expect(controller.state.reviewTarget).toEqual(target)
    expect("commitDetails" in controller.state).toBe(false)
  })

  test("loadTagInspection is read-only", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    // loadTagInspection requires runner; use a stub that throws without runner
    await expect(controller.loadTagInspection({ name: "v1.0", ref: "refs/tags/v1.0", kind: "lightweight", objectOid: "abc", targetOid: "def", subject: "" })).rejects.toThrow()
    expect(controller.state.reviewTarget).toEqual(working.reviewTarget)
  })

  test("recordInspectionError sets banner without changing reviewTarget", async () => {
    const controller = new AppController({
      load: async () => working,
      loadBranch: async () => branch,
      loadCommits: async () => commits,
      loadCommit: async () => details,
      inferBase: async () => ({ kind: "confident", ref: "main~1", oid: "base", reason: "test" }),
    })
    await controller.switchMode("branch")
    const target = controller.state.reviewTarget
    controller.recordInspectionError(new Error("preview failed"))
    expect(controller.state.banner).toContain("preview failed")
    expect(controller.state.reviewTarget).toEqual(target)
  })

  test("resets commit preview state after checking out another branch via mutation", async () => {
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
      const controller = new AppController(runner)
      await controller.refresh()
      await controller.switchMode("branch")
      // loadCommitInspection should remain read-only even after branch checkout
      const targetBefore = controller.state.reviewTarget
      await controller.loadCommitInspection(controller.state.commits?.[0]?.oid ?? "HEAD")
      expect(controller.state.reviewTarget).toEqual(targetBefore)
      await controller.switchLocalBranch("feature")
      expect(controller.state.reviewTarget.kind).not.toBe("commit")
      expect(controller.state.branch).toBe("feature")
      expect("commitDetails" in controller.state).toBe(false)
      expect(controller.state.title).not.toContain("commit-1")
    } finally {
      await repository.cleanup()
    }
  })
})

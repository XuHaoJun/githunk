import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository } from "../helpers/temp-repository"
import type { CommitDetails, CommitSummary } from "../../src/domain/commit"
import type { TagSummary } from "../../src/domain/tag"
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

describe("commit drill-down controller", () => {
  test("loadCommitInspection is read-only and does not mutate reviewTarget", async () => {
    const controller = new AppController({ load: async () => working, loadCommits: async () => commits, loadCommit: async () => details })
    await controller.refresh()
    const target = controller.state.reviewTarget
    const result = await controller.loadCommitInspection("commit-1")
    expect(result.oid).toBe("commit-1")
    expect(controller.state.reviewTarget).toEqual(target)
    expect("commitDetails" in controller.state).toBe(false)
  })

  test("allow-empty commit has empty document files without changing state", async () => {
    const controller = new AppController({ load: async () => working, loadCommits: async () => commits, loadCommit: async () => emptyDetails })
    await controller.refresh()
    const target = controller.state.reviewTarget
    const result = await controller.loadCommitInspection("empty-commit")
    expect(result.document.files).toEqual([])
    expect(controller.state.reviewTarget).toEqual(target)
  })

  test("failed loadCommitInspection leaves prior state intact", async () => {
    const controller = new AppController({ load: async () => working, loadCommits: async () => commits, loadCommit: async () => { throw new Error("not found") } })
    await controller.refresh()
    const target = controller.state.reviewTarget
    await expect(controller.loadCommitInspection("missing")).rejects.toThrow()
    expect(controller.state.reviewTarget).toEqual(target)
  })

  test("loadCommitFileInspection does not mutate state", async () => {
    const controller = new AppController({ load: async () => working, loadCommitFilePatch: async () => details.document })
    await controller.refresh()
    const target = controller.state.reviewTarget
    const result = await controller.loadCommitFileInspection("commit-1", "a.txt")
    expect(result).toBe(details.document)
    expect(controller.state.reviewTarget).toEqual(target)
  })

  test("loadTagInspection is read-only", async () => {
    const repository = await createTempRepository()
    try {
      const runner = new GitRunner(repository.path)
      const controller = new AppController({ runner, load: async () => working })
      await controller.refresh()
      const target = controller.state.reviewTarget
      const tag = { name: "v1", oid: "abc", subject: "", commit: "abc", annotated: false } as unknown as TagSummary
      try { await controller.loadTagInspection(tag) } catch {}
      expect(controller.state.reviewTarget).toEqual(target)
    } finally {
      await repository.cleanup()
    }
  })

  test("recordInspectionError sets banner without changing reviewTarget", async () => {
    const controller = new AppController({ load: async () => working })
    await controller.refresh()
    const target = controller.state.reviewTarget
    controller.recordInspectionError(new Error("boom"))
    expect(controller.state.banner).toContain("boom")
    expect(controller.state.reviewTarget).toEqual(target)
  })

  test("resets commit preview state after checking out another branch via mutation", async () => {
    const controller = new AppController({
      load: async () => working,
      loadCommits: async () => commits,
      loadCommit: async () => details,
    })
    await controller.refresh()
    expect(controller.state.reviewTarget.kind).toBe("working-tree")
  })
})

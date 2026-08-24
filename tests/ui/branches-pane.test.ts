import { describe, expect, test } from "bun:test"
import { branchPaneItems, moveBranchesCursor, selectedBranchItem } from "../../src/ui/panes/branches-pane"
import type { AppModel } from "../../src/domain/repository"

const model = {
  repositoryRoot: "/tmp/repo",
  branch: "main",
  reviewTarget: { kind: "working-tree", scope: "all" },
  files: [],
  patches: [],
  rawPatchSections: [],
  reviewStatuses: {},
  loading: false,
  commandLog: [],
  title: "Working Tree",
  branches: {
    current: "main",
    detached: false,
    localBranches: [{ name: "main", isCurrent: true }],
    remotes: [{ name: "origin", branches: [{ name: "feature/foo", ref: "origin/feature/foo" }] }],
  },
} as AppModel

describe("branch pane selection", () => {
  test("navigates local, remote, and remote branch items", () => {
    expect(branchPaneItems(model).map((item) => item.kind)).toEqual(["local", "remote", "remote-branch"])
    expect(moveBranchesCursor(model, 0, "next")).toBe(1)
    expect(selectedBranchItem(model, 2)).toEqual({ kind: "remote-branch", remote: "origin", name: "feature/foo", ref: "origin/feature/foo" })
  })
})

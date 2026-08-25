import { describe, expect, test } from "bun:test"
import type { AppModel } from "../../src/app/model"
import type { Worktree } from "../../src/domain/worktree"
import {
  MAIN_WORKTREE_LABEL,
  MISSING_WORKTREE_LABEL,
  NO_WORKTREES_THIS_REPO,
  selectedWorktreeFrom,
  worktreePreviewText,
  worktreeRowId,
  worktreeRows,
} from "../../src/ui/panes/worktrees-pane"
import {
  WORKTREE_BRANCH_FG,
  WORKTREE_CURRENT_FG,
  WORKTREE_DETACHED_FG,
  WORKTREE_INACTIVE_MARKER_FG,
  WORKTREE_MISSING_FG,
} from "../../src/ui/theme"

function model(worktrees: readonly Worktree[]): AppModel {
  return { worktrees } as unknown as AppModel
}

const main: Worktree = {
  path: "/repo",
  gitDir: "/repo/.git",
  name: "repo",
  branch: "master",
  head: "1234567890abcdef1234567890abcdef12345678",
  shortHead: "12345678",
  isMain: true,
  isCurrent: true,
  isPathMissing: false,
}

const detached: Worktree = {
  path: "/repo/wt-detached",
  gitDir: "/repo/.git/worktrees/wt-detached",
  name: "wt-detached",
  head: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  shortHead: "abcdefab",
  isMain: false,
  isCurrent: false,
  isPathMissing: false,
}

const missing: Worktree = {
  path: "/repo/wt-gone",
  name: "wt-gone",
  branch: "gone",
  isMain: false,
  isCurrent: false,
  isPathMissing: true,
}

/**
 * pkg/gui/presentation/worktrees.go `GetWorktreeDisplayString`: `[current marker, name, branch or
 * "HEAD detached at <shortHead>" + main label]`. Icons are skipped — githunk renders none — which
 * is also why the missing label is appended to the name (worktrees.go:44-46).
 */
describe("worktree rows", () => {
  test("the current worktree carries a green `  *` marker and every other one a cyan blank", () => {
    const rows = worktreeRows(model([main, detached]))
    expect(rows.map((row) => row.id)).toEqual([worktreeRowId(main), worktreeRowId(detached)])
    expect(rows[0]!.columns[0]!.text).toBe("  *")
    expect(rows[0]!.columns[0]!.color).toBe(WORKTREE_CURRENT_FG)
    expect(rows[1]!.columns[0]!.text).toBe("")
    expect(rows[1]!.columns[0]!.color).toBe(WORKTREE_INACTIVE_MARKER_FG)
  })

  test("a checked-out branch is cyan and the main worktree gets lazygit's label after it", () => {
    const rows = worktreeRows(model([main]))
    expect(rows[0]!.columns[1]!.text).toBe("repo")
    expect(rows[0]!.columns[1]!.color).toBeUndefined()
    expect(rows[0]!.columns[2]!.text).toBe(`master ${MAIN_WORKTREE_LABEL}`)
    expect(rows[0]!.columns[2]!.segments).toEqual([
      { text: "master", color: WORKTREE_BRANCH_FG },
      { text: ` ${MAIN_WORKTREE_LABEL}` },
    ])
    expect(MAIN_WORKTREE_LABEL).toBe("(main worktree)")
  })

  test("a detached worktree shows the shortened head in yellow and no main label", () => {
    const rows = worktreeRows(model([detached]))
    expect(rows[0]!.columns[2]!.text).toBe("HEAD detached at abcdefab")
    expect(rows[0]!.columns[2]!.segments).toEqual([
      { text: "HEAD detached at abcdefab", color: WORKTREE_DETACHED_FG },
    ])
  })

  test("a missing worktree turns red and gets the missing label appended to its name", () => {
    const rows = worktreeRows(model([missing]))
    expect(rows[0]!.columns[1]!.text).toBe(`wt-gone ${MISSING_WORKTREE_LABEL}`)
    expect(rows[0]!.columns[1]!.color).toBe(WORKTREE_MISSING_FG)
    expect(MISSING_WORKTREE_LABEL).toBe("(missing)")
  })

  test("filtering keeps only the worktrees whose name matches", () => {
    const rows = worktreeRows(model([main, detached, missing]), "detach")
    expect(rows.map((row) => row.columns[1]!.text)).toEqual(["wt-detached"])
  })

  test("no worktrees at all yields no rows", () => {
    expect(worktreeRows({} as unknown as AppModel)).toEqual([])
  })

  test("selectedWorktreeFrom resolves a row id back to its worktree", () => {
    const m = model([main, detached])
    expect(selectedWorktreeFrom(m, worktreeRowId(detached))).toEqual(detached)
    expect(selectedWorktreeFrom(m, "worktree:/nope")).toBeUndefined()
    expect(selectedWorktreeFrom(m, undefined)).toBeUndefined()
  })
})

/**
 * pkg/gui/controllers/worktrees_controller.go:88-106 — a tabwriter with padding 2 over
 * `Name:`/`Branch:`/`Path:`, the main and missing labels appended to the name and path cells.
 */
describe("worktree preview", () => {
  test("aligns Name, Branch and Path the way Go's tabwriter does", () => {
    expect(worktreePreviewText(main)).toBe(
      `Name:    repo ${MAIN_WORKTREE_LABEL}\nBranch:  master\nPath:    /repo\n`,
    )
  })

  test("a detached worktree shows the shortened head in the branch row", () => {
    expect(worktreePreviewText(detached)).toBe(
      "Name:    wt-detached\nBranch:  HEAD detached at abcdefab\nPath:    /repo/wt-detached\n",
    )
  })

  test("a missing worktree appends the missing label to the path row", () => {
    expect(worktreePreviewText(missing)).toBe(
      `Name:    wt-gone\nBranch:  gone\nPath:    /repo/wt-gone ${MISSING_WORKTREE_LABEL}\n`,
    )
  })

  test("no selection renders lazygit's NoWorktreesThisRepo string", () => {
    expect(NO_WORKTREES_THIS_REPO).toBe("No worktrees")
  })
})

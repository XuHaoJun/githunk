import { describe, expect, test } from "bun:test"
import type { AppModel } from "../../src/app/model"
import type { ChangedFile } from "../../src/domain/review-target"
import { COLLAPSED_ARROW, EXPANDED_ARROW, collapseAllFileTree, expandAllFileTree, fileTreeRows, toggleFileTreeCollapsedPath, toggleFileTreeMode } from "../../src/ui/file-tree"
import {
  FILES_JUMP_KEY,
  FILES_TABS,
  NO_CHANGED_FILES,
  createFilesTreeState,
  fileHasStagedChanges,
  fileHasUnstagedChanges,
  fileIsTracked,
  fileShortStatus,
  filesTreeRows,
} from "../../src/ui/panes/files-pane"
import { FILE_MIXED_FG, FILE_STAGED_FG, UNSTAGED_CHANGES_FG } from "../../src/ui/theme"

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    indexStatus: ".",
    worktreeStatus: "M",
    untracked: false,
    conflicted: false,
    additions: 1,
    deletions: 0,
    ...extra,
  }
}

function model(files: readonly ChangedFile[], reviewStatuses: AppModel["reviewStatuses"] = {}): AppModel {
  return { files, reviewStatuses, reviewTarget: { kind: "working-tree", scope: "all" } } as unknown as AppModel
}

const staged = file("src/ui/a.ts", { indexStatus: "M", worktreeStatus: "." })
const unstaged = file("src/ui/b.ts")
const untracked = file("README.md", { indexStatus: ".", worktreeStatus: "?", untracked: true, additions: 0 })

/** The rendered tree text of every row — the flex column, marker column excluded. */
function treeLines(rows: readonly { readonly columns: readonly { readonly text: string }[] }[]): string[] {
  return rows.map((row) => row.columns[1]!.text)
}

/** lazygit's `models.File.ShortStatus` — the two-character porcelain XY pair (models/file.go:149). */
describe("short status derivation", () => {
  test("maps githunk's porcelain-v2 dots onto lazygit's spaces, and untracked onto ??", () => {
    expect(fileShortStatus(staged)).toBe("M ")
    expect(fileShortStatus(unstaged)).toBe(" M")
    expect(fileShortStatus(untracked)).toBe("??")
    expect(fileShortStatus(file("x", { indexStatus: "M", worktreeStatus: "M" }))).toBe("MM")
  })

  test("derives staged, unstaged and tracked exactly as deriveStatusFields does", () => {
    // models/file.go:150-153: staged when the first char is not " ", "U" or "?"; unstaged when
    // the second is not " "; untracked when the whole status is "??", "A " or "AM".
    expect(fileHasStagedChanges(staged)).toBe(true)
    expect(fileHasUnstagedChanges(staged)).toBe(false)
    expect(fileHasStagedChanges(unstaged)).toBe(false)
    expect(fileHasUnstagedChanges(unstaged)).toBe(true)
    expect(fileHasStagedChanges(untracked)).toBe(false)
    expect(fileHasUnstagedChanges(untracked)).toBe(true)
    expect(fileIsTracked(untracked)).toBe(false)
    expect(fileIsTracked(staged)).toBe(true)
    expect(fileHasStagedChanges(file("x", { indexStatus: "U", worktreeStatus: "U", conflicted: true }))).toBe(false)
    expect(fileIsTracked(file("x", { indexStatus: "A", worktreeStatus: "." }))).toBe(false)
  })
})

describe("panel 2 tab labels", () => {
  test("are lazygit's `{files, worktrees, submodules}` side-panel group", () => {
    // pkg/config/user_config.go:872, titled by pkg/gui/views.go:188-191.
    expect(FILES_TABS).toEqual(["Files", "Worktrees", "Submodules"])
    expect(FILES_JUMP_KEY).toBe("2")
  })
})

/**
 * pkg/gui/presentation/files.go `getFileLine`: `indentation` then either the arrow plus a space
 * (directories) or the two-character status plus a space (files), then the depth-truncated name.
 */
describe("files tab tree rows", () => {
  test("renders lazygit's root item and compressed directory chain", () => {
    const state = createFilesTreeState(model([staged, unstaged, untracked]))
    const rows = filesTreeRows(state, model([staged, unstaged, untracked]))
    expect(rows.map((row) => row.id)).toEqual(["dir:.", "file:./README.md", "dir:./src/ui", "file:./src/ui/a.ts", "file:./src/ui/b.ts"])
    expect(treeLines(rows)).toEqual([
      `${EXPANDED_ARROW} /`,
      "  ?? README.md",
      `  ${EXPANDED_ARROW} src/ui`,
      "    M  a.ts",
      "     M b.ts",
    ])
  })

  test("keeps githunk's review-status marker in its own leading column", () => {
    const m = model([staged, unstaged, untracked], { "src/ui/a.ts": "reviewed", "src/ui/b.ts": "reviewing", "README.md": "changed-after-review" })
    const rows = filesTreeRows(createFilesTreeState(m), m)
    expect(rows.map((row) => row.columns[0]!.text)).toEqual([" ", "!", " ", "●", "◐"])
    const plain = model([file("top.txt")])
    expect(filesTreeRows(createFilesTreeState(plain), plain)[0]!.columns[0]!.text).toBe("○")
  })

  test("colours the two status characters independently of the row's name colour", () => {
    const m = model([staged, unstaged, untracked])
    const rows = filesTreeRows(createFilesTreeState(m), m)
    const readme = rows.find((row) => row.id === "file:./README.md")!
    const stagedRow = rows.find((row) => row.id === "file:./src/ui/a.ts")!
    const unstagedRow = rows.find((row) => row.id === "file:./src/ui/b.ts")!
    // files.go:184-199 formatFileStatus: staged char green, unstaged char red, "?" red, " " the
    // row's own colour. files.go:135/137: staged-only names are green, mixed ones yellow.
    expect(readme.columns[1]!.segments).toEqual([
      { text: "  " },
      { text: "?", color: UNSTAGED_CHANGES_FG },
      { text: "?", color: UNSTAGED_CHANGES_FG },
      { text: " " },
      { text: "README.md" },
    ])
    expect(stagedRow.columns[1]!.segments).toEqual([
      { text: "    " },
      { text: "M", color: FILE_STAGED_FG },
      { text: " ", color: FILE_STAGED_FG },
      { text: " ", color: FILE_STAGED_FG },
      { text: "a.ts", color: FILE_STAGED_FG },
    ])
    expect(unstagedRow.columns[1]!.segments).toEqual([
      { text: "    " },
      { text: " " },
      { text: "M", color: UNSTAGED_CHANGES_FG },
      { text: " " },
      { text: "b.ts" },
    ])
  })

  test("a directory takes its colour from its subtree: green when staged-only, yellow when mixed", () => {
    const mixed = model([staged, unstaged])
    const mixedRows = filesTreeRows(createFilesTreeState(mixed), mixed)
    expect(mixedRows[0]!.columns[1]!.segments).toEqual([
      { text: `${EXPANDED_ARROW} `, color: FILE_MIXED_FG },
      { text: "src/ui", color: FILE_MIXED_FG },
    ])

    const allStaged = model([staged, file("src/ui/c.ts", { indexStatus: "A", worktreeStatus: "." })])
    const stagedRows = filesTreeRows(createFilesTreeState(allStaged), allStaged)
    expect(stagedRows[0]!.columns[1]!.segments?.[0]).toEqual({ text: `${EXPANDED_ARROW} `, color: FILE_STAGED_FG })

    const allUnstaged = model([unstaged, untracked])
    const unstagedRows = filesTreeRows(createFilesTreeState(allUnstaged), allUnstaged)
    const dir = unstagedRows.find((row) => row.id.startsWith("dir:"))!
    expect(dir.columns[1]!.segments?.[0]).toEqual({ text: `${EXPANDED_ARROW} ` })
  })

  test("collapsing a directory swaps its arrow and hides its children", () => {
    const m = model([staged, unstaged, untracked])
    const directory = fileTreeRows(createFilesTreeState(m)).find((row) => row.path === "src/ui")!
    const collapsed = toggleFileTreeCollapsedPath(createFilesTreeState(m), directory.internalPath)
    expect(treeLines(filesTreeRows(collapsed, m))).toEqual([
      `${EXPANDED_ARROW} /`,
      "  ?? README.md",
      `  ${COLLAPSED_ARROW} src/ui`,
    ])
    expect(treeLines(filesTreeRows(collapseAllFileTree(createFilesTreeState(m)), m))).toEqual([`${COLLAPSED_ARROW} /`])
    expect(treeLines(filesTreeRows(expandAllFileTree(collapsed), m))).toHaveLength(5)
  })

  test("flat mode drops the directory rows and shows whole paths", () => {
    const m = model([staged, unstaged, untracked])
    const flat = toggleFileTreeMode(createFilesTreeState(m))
    expect(flat.mode).toBe("flat")
    // buildFlatTreeFromFiles ranks conflicts, then tracked files, then untracked ones.
    expect(treeLines(filesTreeRows(flat, m))).toEqual([
      "M  src/ui/a.ts",
      " M src/ui/b.ts",
      "?? README.md",
    ])
    expect(toggleFileTreeMode(flat).mode).toBe("tree")
  })

  test("a rename renders lazygit's `old → new` at the truncated depth", () => {
    const renamed = file("src/ui/new.ts", { indexStatus: "R", worktreeStatus: ".", previousPath: "src/ui/old.ts" })
    const m = model([renamed, unstaged])
    expect(treeLines(filesTreeRows(createFilesTreeState(m), m))).toEqual([
      `${EXPANDED_ARROW} src/ui`,
      "   M b.ts",
      "  R  old.ts → new.ts",
    ])
  })

  test("an empty working tree renders the empty-list message text", () => {
    const m = model([])
    expect(filesTreeRows(createFilesTreeState(m), m)).toEqual([])
    expect(NO_CHANGED_FILES).toBe("No changed files")
  })
})

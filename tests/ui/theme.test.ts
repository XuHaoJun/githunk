import { describe, expect, test } from "bun:test"
import { parseColor } from "@opentui/core"
import {
  brightenAnsiForeground,
  FILE_MIXED_FG,
  FILE_STAGED_FG,
  REFLOG_HASH_FG,
  SELECTED_LINE_BG,
  SUBMODULE_NAME_FG,
  SUBMODULE_PATH_FG,
  SUBMODULE_URL_FG,
  TAB_ACTIVE_FG,
  TAB_SEPARATOR,
  TITLE_PREFIX_FRAME_RUNE,
  UNSTAGED_CHANGES_FG,
  WORKTREE_BRANCH_FG,
  WORKTREE_CURRENT_FG,
  WORKTREE_DETACHED_FG,
  WORKTREE_INACTIVE_MARKER_FG,
  WORKTREE_MISSING_FG,
} from "../../src/ui/theme"

describe("lazygit theme constants", () => {
  test("selected line background is lazygit's ANSI blue, not opentui's bright blue", () => {
    // user_config.go:889 SelectedLineBgColor: ["blue"] — ANSI 4, rendered as CSS navy.
    expect(SELECTED_LINE_BG.toLowerCase()).toBe("#000080")
    expect(SELECTED_LINE_BG.toLowerCase()).not.toBe("#0000ff")
    expect(parseColor(SELECTED_LINE_BG).toInts()).toEqual([0, 0, 128, 255])
  })

  test("active tab foreground is ANSI green", () => {
    // user_config.go:885 ActiveBorderColor: ["green","bold"] -> gui.go:1254 SelFgColor.
    expect(parseColor(TAB_ACTIVE_FG).toInts()).toEqual([0, 128, 0, 255])
  })

  test("reflog hash foreground is ANSI blue", () => {
    // reflog_commits.go:43 hashColor := style.FgBlue — ANSI 4, the same pinning as the
    // selected-line background.
    expect(parseColor(REFLOG_HASH_FG).toInts()).toEqual([0, 0, 128, 255])
  })

  test("tab separator and title prefix frame rune match gocui's drawTitle", () => {
    expect(TAB_SEPARATOR).toBe(" - ")
    expect(TITLE_PREFIX_FRAME_RUNE).toBe("─")
  })

  test("file-tree name colours are lazygit's staged green and mixed yellow", () => {
    // files.go:135 nameColor = style.FgGreen (staged only), files.go:137 style.FgYellow (mixed).
    expect(parseColor(FILE_STAGED_FG).toInts()).toEqual([0, 128, 0, 255])
    expect(parseColor(FILE_MIXED_FG).toInts()).toEqual([128, 128, 0, 255])
  })

  test("the unstaged-change status character is lazygit's ANSI red", () => {
    // user_config.go:895 UnstagedChangesColor: ["red"], read by files.go:195 formatFileStatus.
    expect(parseColor(UNSTAGED_CHANGES_FG).toInts()).toEqual([128, 0, 0, 255])
  })

  test("worktree row colours match presentation/worktrees.go", () => {
    // worktrees.go:25-28 currentColor, :33 FgRed for a missing path, :50/:52 branch vs detached.
    expect(parseColor(WORKTREE_CURRENT_FG).toInts()).toEqual([0, 128, 0, 255])
    expect(parseColor(WORKTREE_INACTIVE_MARKER_FG).toInts()).toEqual([0, 128, 128, 255])
    expect(parseColor(WORKTREE_MISSING_FG).toInts()).toEqual([128, 0, 0, 255])
    expect(parseColor(WORKTREE_BRANCH_FG).toInts()).toEqual([0, 128, 128, 255])
    expect(parseColor(WORKTREE_DETACHED_FG).toInts()).toEqual([128, 128, 0, 255])
  })

  test("submodule preview colours match submodules_controller.go:117-119", () => {
    expect(parseColor(SUBMODULE_NAME_FG).toInts()).toEqual([0, 128, 0, 255])
    expect(parseColor(SUBMODULE_PATH_FG).toInts()).toEqual([128, 128, 0, 255])
    expect(parseColor(SUBMODULE_URL_FG).toInts()).toEqual([0, 128, 128, 255])
  })

  test("a base-ANSI foreground is promoted to its bright variant on a highlighted row", () => {
    // view.go:665-670 — `fgColor += 8` when the colour is one of ColorBlack..ColorWhite
    // (attribute.go:37-45), i.e. exactly the 8 base ANSI colours.
    expect(brightenAnsiForeground("#000000")).toBe("#666666")
    expect(brightenAnsiForeground(UNSTAGED_CHANGES_FG)).toBe("#ff6666")
    expect(brightenAnsiForeground(FILE_STAGED_FG)).toBe("#66ff66")
    expect(brightenAnsiForeground(FILE_MIXED_FG)).toBe("#ffff66")
    expect(brightenAnsiForeground(REFLOG_HASH_FG)).toBe("#6666ff")
    expect(brightenAnsiForeground("#800080")).toBe("#ff66ff")
    expect(brightenAnsiForeground(WORKTREE_BRANCH_FG)).toBe("#66ffff")
    expect(brightenAnsiForeground("#c0c0c0")).toBe("#ffffff")
    // Case-insensitive, and an opaque 8-digit hex resolves the same way.
    expect(brightenAnsiForeground("#008000")).toBe(brightenAnsiForeground("#008000ff"))
    expect(brightenAnsiForeground("#008000")).toBe(brightenAnsiForeground("#008000".toUpperCase()))
  })

  test("the bright variants are the hexes opentui's own bright palette names resolve to", () => {
    const bright = (name: string) => parseColor(name).toInts()
    expect(parseColor(brightenAnsiForeground("#000000")).toInts()).toEqual(bright("brightblack"))
    expect(parseColor(brightenAnsiForeground(UNSTAGED_CHANGES_FG)).toInts()).toEqual(bright("brightred"))
    expect(parseColor(brightenAnsiForeground(FILE_STAGED_FG)).toInts()).toEqual(bright("brightgreen"))
    expect(parseColor(brightenAnsiForeground(FILE_MIXED_FG)).toInts()).toEqual(bright("brightyellow"))
    expect(parseColor(brightenAnsiForeground(REFLOG_HASH_FG)).toInts()).toEqual(bright("brightblue"))
    expect(parseColor(brightenAnsiForeground("#800080")).toInts()).toEqual(bright("brightmagenta"))
    expect(parseColor(brightenAnsiForeground(WORKTREE_BRANCH_FG)).toInts()).toEqual(bright("brightcyan"))
    expect(parseColor(brightenAnsiForeground("#c0c0c0")).toInts()).toEqual(bright("brightwhite"))
  })

  test("a colour outside the base-8 ANSI range is returned unchanged", () => {
    // view.go:666-668 only promotes ColorBlack..ColorWhite; a truecolor or already-bright
    // foreground falls through untouched (it still gets bold, which is not this function's job).
    expect(brightenAnsiForeground("#1a2b3c")).toBe("#1a2b3c")
    expect(brightenAnsiForeground("#0000ff")).toBe("#0000ff")
    expect(brightenAnsiForeground("#66ffff")).toBe("#66ffff")
    expect(brightenAnsiForeground("")).toBe("")
  })

  test("no base-ANSI colour brightens to the selection background", () => {
    // The bug this mapping fixes: REFLOG_HASH_FG and SELECTED_LINE_BG are the same navy, so an
    // un-brightened selected reflog row painted its hash invisibly.
    expect(REFLOG_HASH_FG).toBe(SELECTED_LINE_BG)
    expect(brightenAnsiForeground(REFLOG_HASH_FG)).not.toBe(SELECTED_LINE_BG)
  })
})

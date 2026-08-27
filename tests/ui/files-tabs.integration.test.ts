import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { TextAttributes, type RGBA } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { createRegistry, type UiState } from "../../src/ui/bindings"
import type { AppModel } from "../../src/app/model"
import { paneTabsPlainTitle } from "../../src/ui/pane-tabs"
import { COLLAPSED_ARROW, EXPANDED_ARROW } from "../../src/ui/file-tree"
import { FILES_TABS } from "../../src/ui/panes/files-pane"
import { MAIN_WORKTREE_LABEL, NO_WORKTREES_THIS_REPO } from "../../src/ui/panes/worktrees-pane"
import { NO_SUBMODULES } from "../../src/ui/panes/submodules-pane"

/** The spans covering `[startX, endX]` on `row`, in paint order. */
function spansAt(harness: ShellHarness, row: number, startX: number, endX: number) {
  const line = harness.captureSpans().lines[row]
  expect(line).toBeDefined()
  const out: Array<{ text: string; x: number; fg: RGBA; bg: RGBA; attributes: number }> = []
  let x = 0
  for (const span of line!.spans) {
    const spanEnd = x + span.width - 1
    if (spanEnd >= startX && x <= endX) {
      out.push({ text: span.text, x, fg: span.fg, bg: span.bg, attributes: span.attributes })
    }
    x = spanEnd + 1
  }
  return out
}

function isIndexed(color: RGBA, slot: number): boolean {
  return color.intent === "indexed" && color.slot === slot
}

/** A fixture with a compressible directory chain plus a top-level file. */
const nestedTree = async (repository: TempRepository): Promise<void> => {
  await repository.write("root.txt", "root\n")
  await repository.write("src/ui/panes/one.txt", "one\n")
  await repository.git(["add", "."])
  await repository.git(["commit", "-m", "base commit"])
  // A modified tracked file and two untracked ones, so the tree has a compressible chain
  // (src -> ui -> panes) alongside a top-level entry.
  await repository.write("src/ui/panes/one.txt", "one changed\n")
  await repository.write("src/ui/panes/two.txt", "two\n")
  await repository.write("top.txt", "top\n")
}

/**
 * Panel 2's side-panel group is lazygit's `{"files", "worktrees", "submodules"}`
 * (pkg/config/user_config.go:872), and its Files tab renders `pkg/gui/filetree` through
 * `pkg/gui/presentation/files.go`.
 */
/** One staged modification (a green `M ` status) and one untracked file (a red `??`). */
const stagedAndUntracked = async (repository: TempRepository): Promise<void> => {
  await repository.write("tracked.txt", "one\n")
  await repository.git(["add", "."])
  await repository.git(["commit", "-m", "base commit"])
  await repository.write("tracked.txt", "one changed\n")
  await repository.git(["add", "tracked.txt"])
  await repository.write("untracked.txt", "new\n")
}

describe("panel 2 tabs", () => {
  let harness: ShellHarness | undefined
  const extras: TempRepository[] = []

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    while (extras.length > 0) await extras.pop()?.cleanup().catch(() => {})
  })

  test("the border row shows [2]─Files - Worktrees - Submodules with the active tab styled only while focused", async () => {
    harness = await createShellHarness()
    await harness.pressKey("2")
    await harness.flush()
    const view = harness.app.view!
    const win = view.geometry.windows.files!
    const expected = paneTabsPlainTitle({ jumpKey: "2", tabs: FILES_TABS })
    expect(expected).toBe("[2]─Files - Worktrees - Submodules")
    const borderRow = harness.frame().split("\n")[win.y0]!
    expect(borderRow.slice(win.x0 + 2, win.x0 + 2 + expected.length)).toBe(expected)

    const styled = harness.app.view!.filesTitleStyled
    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe(expected)
    expect(styled.chunks.find((chunk) => chunk.text === "Files")!.fg).toBeDefined()
    expect(styled.chunks.find((chunk) => chunk.text === "Worktrees")!.fg).toBeUndefined()

    const filesStart = win.x0 + 2 + "[2]─".length
    const active = spansAt(harness, win.y0, filesStart, filesStart + "Files".length - 1).find((s) => s.text.includes("Files"))
    expect(active).toBeDefined()
    expect(isIndexed(active!.fg, 2)).toBe(true)
    expect(active!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    const worktreesStart = filesStart + "Files - ".length
    const worktreeSpans = spansAt(harness, win.y0, worktreesStart, worktreesStart + "Worktrees".length - 1)
    expect(worktreeSpans.every((s) => !isIndexed(s.fg, 2))).toBe(true)

    // gocui's drawTitle highlights the active tab only while the view is focused.
    await harness.pressKey("1")
    await harness.flush()
    const unfocused = spansAt(harness, win.y0, filesStart, filesStart + "Files".length - 1)
    expect(unfocused.every((s) => !isIndexed(s.fg, 2))).toBe(true)
    expect(harness.frame().split("\n")[win.y0]!).toContain("[2]─Files - Worktrees - Submodules")
  })

  test("] and [ cycle panel 2's tabs with wraparound and stay inert in main", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("2")
    expect(view.activeFilesTab).toBe("files")
    await harness.pressKey("]")
    expect(view.activeFilesTab).toBe("worktrees")
    await harness.pressKey("]")
    expect(view.activeFilesTab).toBe("submodules")
    await harness.pressKey("]")
    expect(view.activeFilesTab).toBe("files")
    await harness.pressKey("[")
    expect(view.activeFilesTab).toBe("submodules")
    await harness.pressKey("[")
    expect(view.activeFilesTab).toBe("worktrees")
    await harness.pressKey("[")
    expect(view.activeFilesTab).toBe("files")

    // Main's brackets belong to the working-tree scope ring and never touch panel 2's tabs.
    await harness.pressKey("0")
    await harness.pressKey("]")
    await harness.settle()
    expect(view.activeFilesTab).toBe("files")

    const registry = createRegistry()
    expect(registry.dispatch({ name: "]" }, { context: "main" })).toBe("scope-next")
    expect(registry.dispatch({ name: "[" }, { context: "main" })).toBe("scope-previous")
    expect(registry.dispatch({ name: "]" }, { context: "files" })).toBe("tab-next")
    expect(registry.dispatch({ name: "[" }, { context: "files" })).toBe("tab-previous")
  })

  test("clicking a tab in the title row activates it", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("1")
    await harness.flush()
    const win = view.geometry.windows.files!
    // GetClickedTabIndex counts the border column, "[2]", its frame rune, then the labels:
    // "Files" is offsets 5..9, " - " 10..12, "Worktrees" 13..21, " - " 22..24, "Submodules" 25..34.
    await harness.mockMouse.click(win.x0 + 15, win.y0)
    await harness.flush()
    expect(view.activeFilesTab).toBe("worktrees")
    expect(view.focusManager.active).toBe("files")

    await harness.mockMouse.click(win.x0 + 23, win.y0)
    await harness.flush()
    expect(view.activeFilesTab).toBe("worktrees")

    await harness.mockMouse.click(win.x0 + 27, win.y0)
    await harness.flush()
    expect(view.activeFilesTab).toBe("submodules")

    await harness.mockMouse.click(win.x0 + 7, win.y0)
    await harness.flush()
    expect(view.activeFilesTab).toBe("files")
  })

  test("the Files tab renders a real nested tree with a compressed chain, indentation and arrows", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    const lines = view.renderedListText("files").split("\n")
    // src/ui/panes is a single-child chain, so it is compressed onto one row (build_tree.go).
    // Every line is the review marker, a space, then lazygit's own
    // indentation + arrow-or-status + " " + name.
    expect(lines).toEqual([
      `  ${EXPANDED_ARROW} src/ui/panes`,
      "○    M one.txt",
      "○   ?? two.txt",
      "○ ?? top.txt",
    ])
  })

  test("the selected file row's status characters are brightened and bolded with ANSI intent", async () => {
    // view.go:665-680: a highlighted line's foregrounds are promoted to their bright ANSI variant
    // and bolded before lazygit applies SelBgColor.
    const shell = await createShellHarness({ setup: stagedAndUntracked })
    harness = shell
    const view = shell.app.view!
    await shell.pressKey("2")
    await shell.flush()
    expect(view.renderedListText("files").split("\n")).toEqual(["○ M  tracked.txt", "○ ?? untracked.txt"])

    const geometry = shell.paneTextGeometry("files")!
    const rowSpans = (offset: number) =>
      spansAt(shell, geometry.screenY + offset, geometry.screenX, geometry.screenX + geometry.width - 1)

    // Row 0 is selected: staged status is ANSI green promoted to bright ANSI green.
    const staged = rowSpans(0).find((s) => s.text.includes("M"))
    expect(staged).toBeDefined()
    expect(isIndexed(staged!.bg, 4)).toBe(true)
    expect(isIndexed(staged!.fg, 10)).toBe(true)
    expect(staged!.fg).not.toEqual(staged!.bg)
    expect(staged!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    // Row 1 is not selected, so it keeps lazygit's plain ANSI red.
    const unselected = rowSpans(1).find((s) => s.text.includes("??"))
    expect(unselected).toBeDefined()
    expect(isIndexed(unselected!.fg, 1)).toBe(true)
    expect(isIndexed(unselected!.bg, 4)).toBe(false)

    await shell.pressKey("j")
    await shell.settle()
    expect(view.selectedListId("files")).toBe("untracked.txt")
    const nowSelected = rowSpans(1).find((s) => s.text.includes("??"))
    expect(nowSelected).toBeDefined()
    expect(isIndexed(nowSelected!.bg, 4)).toBe(true)
    expect(isIndexed(nowSelected!.fg, 9)).toBe(true)
    expect(nowSelected!.fg).not.toEqual(nowSelected!.bg)
    expect(nowSelected!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
  })

  test("enter toggles a directory row's collapse, and `, - and = drive the tree mode", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    expect(view.renderedListText("files")).toContain(`${EXPANDED_ARROW} src/ui/panes`)

    await harness.pressKey("RETURN")
    await harness.flush()
    expect(view.renderedListText("files")).toContain(`${COLLAPSED_ARROW} src/ui/panes`)
    expect(view.renderedListText("files")).not.toContain("one.txt")
    // Collapsing a directory must not steal focus the way opening a file does.
    expect(view.focusManager.active).toBe("files")

    await harness.pressKey("RETURN")
    await harness.flush()
    expect(view.renderedListText("files")).toContain(`${EXPANDED_ARROW} src/ui/panes`)

    await harness.pressKey("-")
    await harness.flush()
    expect(view.renderedListText("files")).toContain(`${COLLAPSED_ARROW} src/ui/panes`)
    await harness.pressKey("=")
    await harness.flush()
    expect(view.renderedListText("files")).toContain(`${EXPANDED_ARROW} src/ui/panes`)

    await harness.pressKey("`")
    await harness.flush()
    expect(view.filesTree.mode).toBe("flat")
    const flat = view.renderedListText("files")
    expect(flat).not.toContain(EXPANDED_ARROW)
    expect(flat).toContain("src/ui/panes/one.txt")
    await harness.pressKey("`")
    await harness.flush()
    expect(view.filesTree.mode).toBe("tree")
  })

  test("space on a directory row stages its whole subtree and unstages it again", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    expect(view.selectedListId("files")).toBe("src/ui/panes")

    await harness.pressKey(" ")
    await harness.settle()
    const staged = (await harness.repository.git(["diff", "--cached", "--name-only"])).stdout.trim().split("\n").sort()
    expect(staged).toEqual(["src/ui/panes/one.txt", "src/ui/panes/two.txt"])
    expect(view.selectedListId("files")).toBe("src/ui/panes")

    await harness.pressKey(" ")
    await harness.settle()
    expect((await harness.repository.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("")
  })

  test("d on a directory row discards its whole subtree after the second press", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    expect(view.selectedListId("files")).toBe("src/ui/panes")

    await harness.pressKey("d")
    await harness.flush()
    expect(String(view.filesPane.box.bottomTitle)).toContain("src/ui/panes")
    // Still there: the first press only asks.
    expect((await harness.repository.git(["status", "--porcelain"])).stdout).toContain("src/ui/panes/one.txt")

    await harness.pressKey("d")
    await harness.settle()
    const status = (await harness.repository.git(["status", "--porcelain"])).stdout
    expect(status).not.toContain("src/ui/panes")
    expect(status).toContain("top.txt")
  })

  test("r reports that mark-reviewed needs a file row rather than silently doing nothing", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    expect(view.selectedListId("files")).toBe("src/ui/panes")

    await harness.pressKey("r")
    await harness.settle()
    expect(String(view.filesPane.box.bottomTitle)).toContain("file")
    const statuses = harness.app.controller.state.reviewStatuses ?? {}
    expect(Object.prototype.hasOwnProperty.call(statuses, "src/ui/panes")).toBe(false)
    expect(statuses["src/ui/panes/one.txt"]).toBe("not-reviewed")

    // On a file row it still marks that file, unchanged.
    await harness.pressKey("j")
    await harness.flush()
    expect(view.selectedListId("files")).toBe("src/ui/panes/one.txt")
    await harness.pressKey("r")
    await harness.settle()
    expect(harness.app.controller.state.reviewStatuses?.["src/ui/panes/one.txt"]).toBe("reviewed")
  })

  test("selecting a directory row labels the main preview with the directory, without marking it reviewing", async () => {
    harness = await createShellHarness({ setup: nestedTree })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.flush()
    expect(view.mainContent?.source).toBe("files")
    expect(view.mainContent?.label).toBe("src/ui/panes")
    expect(Object.prototype.hasOwnProperty.call(harness.app.controller.state.reviewStatuses ?? {}, "src/ui/panes")).toBe(false)

    await harness.pressKey("j")
    await harness.flush()
    expect(view.mainContent?.label).toBe("src/ui/panes/one.txt")
    expect(harness.app.controller.state.reviewStatuses?.["src/ui/panes/one.txt"]).toBe("reviewing")
  })

  test("the Worktrees tab lists real worktrees with the current marker, a detached head and previews them", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("a.txt", "base\n")
        await repository.git(["add", "a.txt"])
        await repository.git(["commit", "-m", "base commit"])
        expect((await repository.git(["worktree", "add", "wt-feature", "-b", "feature"])).exitCode).toBe(0)
        expect((await repository.git(["worktree", "add", "--detach", "wt-detached"])).exitCode).toBe(0)
        expect((await repository.git(["worktree", "add", "wt-gone", "-b", "gone"])).exitCode).toBe(0)
        await rm(join(repository.path, "wt-gone"), { recursive: true, force: true })
      },
    })
    await harness.app.refresh()
    await harness.flush()
    const view = harness.app.view!
    const worktrees = harness.app.controller.state.worktrees ?? []
    expect(worktrees.length).toBe(4)

    await harness.pressKey("2")
    await harness.pressKey("]")
    await harness.flush()
    expect(view.activeFilesTab).toBe("worktrees")
    const rendered = view.renderedListText("files")
    const main = worktrees[0]!
    expect(main.isCurrent).toBe(true)
    expect(rendered.split("\n")[0]).toContain(`* ${main.name}`)
    expect(rendered).toContain(MAIN_WORKTREE_LABEL)
    expect(rendered).toContain("wt-feature")
    expect(rendered).toContain("HEAD detached at ")
    expect(rendered).toContain("wt-gone (missing)")
    expect(view.selectedListId("files")).toBe(`worktree:${main.path}`)

    expect(view.mainContent?.source).toBe("worktree")
    expect(view.mainContent?.plainText).toBe(`Name:    ${main.name} ${MAIN_WORKTREE_LABEL}\nBranch:  master\nPath:    ${main.path}\n`)

    // Moving onto the detached worktree previews its shortened head.
    const detachedIndex = worktrees.findIndex((worktree) => worktree.branch === undefined)
    expect(detachedIndex).toBeGreaterThan(0)
    for (let moved = 0; moved < detachedIndex; moved += 1) await harness.pressKey("j")
    await harness.flush()
    const detached = worktrees[detachedIndex]!
    expect(view.mainContent?.plainText).toContain(`HEAD detached at ${detached.shortHead}`)
  })

  test("an empty worktree listing renders lazygit's No worktrees message in the list and in main", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    // A repository always has at least the main worktree, so the empty case is driven through
    // the model the same way a failed listing would leave it.
    view.update({ ...harness.app.controller.state, worktrees: [] })
    await harness.pressKey("2")
    await harness.pressKey("]")
    await harness.flush()
    expect(view.renderedListText("files")).toBe(NO_WORKTREES_THIS_REPO)
    expect(view.selectedListId("files")).toBeUndefined()
    expect(view.mainContent?.source).toBe("worktree")
    expect(view.mainContent?.plainText).toBe(NO_WORKTREES_THIS_REPO)
  })

  test("the Submodules tab indents nested submodules and previews the selected one", async () => {
    const inner = await createTempRepository()
    extras.push(inner)
    await inner.write("inner.txt", "inner\n")
    await inner.git(["add", "inner.txt"])
    await inner.git(["commit", "-m", "inner"])
    const mid = await createTempRepository()
    extras.push(mid)
    await mid.write("mid.txt", "mid\n")
    await mid.git(["add", "mid.txt"])
    await mid.git(["commit", "-m", "mid"])
    expect((await mid.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.path, "vendor/inner"])).exitCode).toBe(0)
    await mid.git(["commit", "-m", "add vendor/inner"])

    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("a.txt", "base\n")
        await repository.git(["add", "a.txt"])
        await repository.git(["commit", "-m", "base commit"])
        expect((await repository.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", mid.path, "libs/mid"])).exitCode).toBe(0)
        await repository.git(["commit", "-m", "add libs/mid"])
        await repository.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
      },
    })
    await harness.app.refresh()
    await harness.flush()
    const view = harness.app.view!
    const submodules = harness.app.controller.state.submodules ?? []
    expect(submodules.map((submodule) => submodule.name)).toEqual(["libs/mid", "vendor/inner"])

    await harness.pressKey("2")
    await harness.pressKey("[")
    await harness.flush()
    expect(view.activeFilesTab).toBe("submodules")
    expect(view.renderedListText("files").split("\n")).toEqual(["libs/mid", "  - vendor/inner"])
    expect(view.selectedListId("files")).toBe("submodule:libs/mid")
    expect(view.mainContent?.source).toBe("submodule")
    expect(view.mainContent?.plainText).toBe(`Name: libs/mid\nPath: libs/mid\nUrl:  ${mid.path}\n\n`)

    await harness.pressKey("j")
    await harness.flush()
    expect(view.selectedListId("files")).toBe("submodule:libs/mid/vendor/inner")
    expect(view.mainContent?.plainText).toBe(`Name: libs/mid/vendor/inner\nPath: libs/mid/vendor/inner\nUrl:  ${inner.path}\n\n`)
  })

  test("a repository with no submodules renders lazygit's No submodules message", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.pressKey("[")
    await harness.flush()
    expect(view.activeFilesTab).toBe("submodules")
    expect(view.renderedListText("files")).toBe(NO_SUBMODULES)
    expect(view.mainContent?.source).toBe("submodule")
    expect(view.mainContent?.plainText).toBe(NO_SUBMODULES)
  })

  test("the read-only tabs make the working-tree actions unavailable", async () => {
    const registry = createRegistry()
    const model = { reviewTarget: { kind: "working-tree", scope: "all" }, files: [] } as unknown as AppModel
    const ui = (filesTab: "files" | "worktrees" | "submodules"): UiState => ({
      focus: "files",
      currentSideWindow: "files",
      screenMode: "normal",
      modal: false,
      mainScope: "all",
      selectedBranchKind: undefined,
      hasSelectedStash: false,
      filesTab,
    })
    for (const key of ["space", "d", "a", "r", "enter", "`", "-", "="] as const) {
      expect(registry.dispatch({ name: key }, { context: "files", model, ui: ui("files") })).toBeDefined()
    }
    for (const tab of ["worktrees", "submodules"] as const) {
      expect(registry.dispatch({ name: "space" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      expect(registry.dispatch({ name: "a" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      expect(registry.dispatch({ name: "r" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      expect(registry.dispatch({ name: "`" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      expect(registry.dispatch({ name: "-" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      expect(registry.dispatch({ name: "=" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
      // No global binding claims `d`, so it is simply unbound on the read-only tabs.
      expect(registry.dispatch({ name: "d" }, { context: "files", model, ui: ui(tab) })).toBeUndefined()
    }
  })
})

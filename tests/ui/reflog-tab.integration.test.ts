import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes, parseColor } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createRegistry, type UiState } from "../../src/ui/bindings"
import { paneTabsPlainTitle } from "../../src/ui/pane-tabs"
import { REFLOG_HASH_FG, SELECTED_LINE_BG, TAB_ACTIVE_FG, brightenAnsiForeground } from "../../src/ui/theme"
import { COMMITS_TABS, reflogRows } from "../../src/ui/panes/reflog-pane"

/** The spans covering `[startX, endX]` on `row`, in paint order. */
function spansAt(harness: ShellHarness, row: number, startX: number, endX: number) {
  const line = harness.captureSpans().lines[row]
  expect(line).toBeDefined()
  const out: Array<{ text: string; x: number; fg: readonly number[]; bg: readonly number[]; attributes: number }> = []
  let x = 0
  for (const span of line!.spans) {
    const spanEnd = x + span.width - 1
    if (spanEnd >= startX && x <= endX) {
      out.push({ text: span.text, x, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes })
    }
    x = spanEnd + 1
  }
  return out
}

/**
 * Panel 4's side-panel group is lazygit's `{"commits", "reflog"}`
 * (pkg/config/user_config.go:874). The reflog rows are
 * `pkg/gui/presentation/reflog_commits.go` `getDisplayStringsForReflogCommit`: short hash in
 * `style.FgBlue`, then the reflog subject in the default text colour.
 */
describe("panel 4 Reflog tab", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("the border row shows [4]─Commits - Reflog with the active tab styled only while focused", async () => {
    harness = await createShellHarness()
    await harness.pressKey("4")
    await harness.flush()
    const view = harness.app.view!
    const win = view.geometry.windows.commits!
    const expected = paneTabsPlainTitle({ jumpKey: "4", tabs: COMMITS_TABS })
    expect(expected).toBe("[4]─Commits - Reflog")
    const borderRow = harness.frame().split("\n")[win.y0]!
    expect(borderRow.slice(win.x0 + 2, win.x0 + 2 + expected.length)).toBe(expected)

    const activeGreen = parseColor(TAB_ACTIVE_FG).toInts()
    const commitsStart = win.x0 + 2 + "[4]─".length
    const commitsSpans = spansAt(harness, win.y0, commitsStart, commitsStart + "Commits".length - 1)
    const active = commitsSpans.find((s) => s.text.includes("Commits"))
    expect(active).toBeDefined()
    expect(active!.fg).toEqual(activeGreen)
    expect(active!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    const reflogStart = commitsStart + "Commits - ".length
    const reflogSpans = spansAt(harness, win.y0, reflogStart, reflogStart + "Reflog".length - 1)
    expect(reflogSpans.every((s) => JSON.stringify(s.fg) !== JSON.stringify(activeGreen))).toBe(true)

    // gocui's drawTitle highlights the active tab only while the view is focused.
    await harness.pressKey("1")
    await harness.flush()
    const unfocused = spansAt(harness, win.y0, commitsStart, commitsStart + "Commits".length - 1)
    expect(unfocused.every((s) => JSON.stringify(s.fg) !== JSON.stringify(activeGreen))).toBe(true)
    expect(harness.frame().split("\n")[win.y0]!).toContain("[4]─Commits - Reflog")
  })

  test("] and [ cycle panel 4's tabs with wraparound and leave panel 4 alone elsewhere", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("4")
    expect(view.activeCommitsTab).toBe("commits")
    await harness.pressKey("]")
    expect(view.activeCommitsTab).toBe("reflog")
    await harness.pressKey("]")
    expect(view.activeCommitsTab).toBe("commits")
    await harness.pressKey("[")
    expect(view.activeCommitsTab).toBe("reflog")
    await harness.pressKey("[")
    expect(view.activeCommitsTab).toBe("commits")

    await harness.pressKey("0")
    await harness.pressKey("]")
    expect(view.activeCommitsTab).toBe("commits")
    // Panel 2 has its own tabs: the bracket cycles those and leaves panel 4 where it was.
    await harness.pressKey("2")
    await harness.pressKey("]")
    expect(view.activeCommitsTab).toBe("commits")
    expect(view.activeFilesTab).toBe("worktrees")

    const registry = createRegistry()
    expect(registry.dispatch({ name: "]" }, { context: "main" })).toBeUndefined()
    expect(registry.dispatch({ name: "[" }, { context: "main" })).toBeUndefined()
    expect(registry.dispatch({ name: "]" }, { context: "commits" })).toBe("tab-next")
    expect(registry.dispatch({ name: "[" }, { context: "commits" })).toBe("tab-previous")
  })

  test("reflog rows carry the short hash in blue and the reflog subject", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit"] })
    const view = harness.app.view!
    const model = harness.app.controller.state
    const entries = model.reflog ?? []
    expect(entries.length).toBeGreaterThan(0)

    const rows = reflogRows(model)
    expect(rows.length).toBe(entries.length)
    expect(rows[0]!.id).toBe(entries[0]!.id)
    expect(rows[0]!.columns[0]!.text).toBe(entries[0]!.shortOid)
    expect(rows[0]!.columns[0]!.color).toBe(REFLOG_HASH_FG)
    expect(rows[0]!.columns[1]!.text).toBe(entries[0]!.subject)
    expect(rows[0]!.columns[1]!.color).toBeUndefined()

    await harness.pressKey("4")
    await harness.pressKey("]")
    await harness.flush()
    const rendered = view.renderedListText("commits")
    expect(rendered).toContain(entries[0]!.shortOid)
    expect(rendered).toContain("beta commit")
    expect(view.selectedListId("commits")).toBe(entries[0]!.id)
  })

  test("the selected reflog row's hash is bright and bold, not navy on navy", async () => {
    // view.go:665-680 brightens and bolds every rune of a highlighted line before swapping in
    // SelBgColor. Without that, REFLOG_HASH_FG (#000080) painted on SELECTED_LINE_BG (#000080)
    // made the selected row's hash invisible.
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit"] })
    await harness.pressKey("4")
    await harness.pressKey("]")
    await harness.settle()
    await harness.flush()
    const entries = harness.app.controller.state.reflog ?? []
    expect(entries.length).toBeGreaterThan(0)
    const shortOid = entries[0]!.shortOid
    expect(harness.app.view!.selectedListId("commits")).toBe(entries[0]!.id)

    const geometry = harness.paneTextGeometry("commits")!
    const spans = spansAt(harness, geometry.screenY, geometry.screenX, geometry.screenX + geometry.width - 1)
    const hash = spans.find((s) => s.text.trim().startsWith(shortOid.slice(0, 4)))
    expect(hash).toBeDefined()
    expect(hash!.bg).toEqual(parseColor(SELECTED_LINE_BG).toInts())
    expect(hash!.fg).not.toEqual(hash!.bg)
    expect(hash!.fg).toEqual(parseColor(brightenAnsiForeground(REFLOG_HASH_FG)).toInts())
    expect(hash!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    // The row below it is unhighlighted, so its hash keeps lazygit's plain FgBlue.
    const below = spansAt(harness, geometry.screenY + 1, geometry.screenX, geometry.screenX + geometry.width - 1)
    const plainHash = below.find((s) => s.text.trim().startsWith(entries[1]!.shortOid.slice(0, 4)))
    expect(plainHash).toBeDefined()
    expect(plainHash!.fg).toEqual(parseColor(REFLOG_HASH_FG).toInts())
  })

  test("selecting a reflog entry previews that commit in the main pane", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.pressKey("]")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})

    const entries = harness.app.controller.state.reflog ?? []
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(entries[0]!.oid)

    await harness.pressKey("j")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    expect(view.selectedListId("commits")).toBe(entries[1]!.id)
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(entries[1]!.oid)
  })

  test("enter on the Reflog tab does not drill into commit files", async () => {
    // lazygit attaches `SwitchToDiffFilesController` (the GoInto → commit files binding) to
    // LocalCommits, SubCommits and Stash only — the reflog context gets
    // `SwitchToSubCommitsController` instead (pkg/gui/controllers.go:240-249), a panel githunk
    // has no equivalent for, so Enter is a no-op here rather than a commit-files drill-down.
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.pressKey("]")
    await harness.settle()
    await harness.pressKey("RETURN")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    expect(view.commitsPanel.child).toBeUndefined()
    expect(view.activeCommitsTab).toBe("reflog")

    const registry = createRegistry()
    const ui: UiState = {
      focus: "commits",
      currentSideWindow: "commits",
      screenMode: "normal",
      modal: false,
      mainScope: "all",
      selectedBranchKind: undefined,
      hasSelectedStash: false,
      commitsTab: "reflog",
    }
    const model = harness.app.controller.state
    expect(registry.dispatch({ name: "return" }, { context: "commits", model, ui })).not.toBe("commit-drilldown")
    expect(registry.dispatch({ name: "return" }, { context: "commits", model, ui: { ...ui, commitsTab: "commits" } })).toBe("commit-drilldown")
  })

  test("the commit-files drill-down still works from the Commits tab and shows its own title", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit"] })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.settle()
    await harness.pressKey("RETURN")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.commitsPanel.child?.value.kind).toBe("commit-files")
    const short = view.commitsPanel.child!.value.details.shortOid
    // lazygit's commit files live in their own view with a dynamic title
    // (pkg/gui/context/commit_files_context.go:48), so no tab strip shows while drilled in.
    expect(harness.frame()).toContain(`[4]─Diff files (${short})`)
    expect(harness.frame()).not.toContain("[4]─Commits - Reflog")

    await harness.pressKey("ESCAPE")
    await harness.settle()
    await harness.flush()
    expect(view.commitsPanel.child).toBeUndefined()
    expect(harness.frame()).toContain("[4]─Commits - Reflog")
  })

  test("clicking the Reflog tab in the title row switches to it", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("1")
    await harness.flush()
    const win = view.geometry.windows.commits!
    // "Reflog" occupies offsets 16..21 from the pane's left edge (GetClickedTabIndex counts the
    // border column, the "[4]" prefix, its frame rune, then "Commits" and the " - " separator).
    await harness.mockMouse.click(win.x0 + 18, win.y0)
    await harness.flush()
    expect(view.activeCommitsTab).toBe("reflog")
    expect(view.focusManager.active).toBe("commits")

    // Offsets 13..15 are the " - " separator, which activates nothing.
    await harness.mockMouse.click(win.x0 + 14, win.y0)
    await harness.flush()
    expect(view.activeCommitsTab).toBe("reflog")

    await harness.mockMouse.click(win.x0 + 8, win.y0)
    await harness.flush()
    expect(view.activeCommitsTab).toBe("commits")
  })

  test("an empty reflog renders lazygit's No reflog history message in the list and in main", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("a.txt", "one\n")
        await repository.git(["add", "a.txt"])
        await repository.git(["commit", "-m", "only commit"])
        await repository.write("b.txt", "unstaged\n")
        await repository.git(["reflog", "expire", "--expire=now", "--all"])
      },
    })
    await harness.app.refresh()
    await harness.flush()
    const view = harness.app.view!
    expect(harness.app.controller.state.reflog ?? []).toEqual([])

    await harness.pressKey("4")
    await harness.pressKey("]")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    expect(view.renderedListText("commits")).toBe("No reflog history")
    expect(view.selectedListId("commits")).toBeUndefined()
    expect(view.mainContent?.source).toBe("reflog")
    expect(view.mainContent?.plainText).toBe("No reflog history")
  })
})

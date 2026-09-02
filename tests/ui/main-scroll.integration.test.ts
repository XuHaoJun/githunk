import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { getMainDiffLineRangeState } from "../../src/ui/panes/main-pane"
import { diffLineSelectionRange } from "../../src/domain/diff/line-selection"
import { MAIN_SCROLL_HEIGHT } from "../../src/ui/root-view"

/**
 * Scrolling the main view, as lazygit does it.
 *
 * Two separate things are bound, and githunk had conflated them:
 *
 *   - **Globally**, whatever holds focus, `<pgup>`/`<pgdown>`, `K`/`J` and `<ctrl+u>`/`<ctrl+d>`
 *     scroll the main view by `gui.scrollHeight` lines — default 2
 *     (pkg/config/user_config.go:857, pkg/gui/global_handlers.go:15-22, keybindings.go:87-100).
 *     All six are aliases of the one handler.
 *   - **With the main view focused**, `Contexts.Normal` carries a `ViewSelectionController`
 *     (pkg/gui/controllers.go:310-314), whose `j`/`k` scroll *one line*, `,`/`.` scroll a page
 *     (`InnerHeight() - 1`) and `<`/`>` jump to the ends
 *     (pkg/gui/controllers/view_selection_controller.go:37-97).
 *
 * lazygit's main view has no hunk cursor: hunk-granular movement lives in the staging contexts,
 * which are a different view entirely. githunk keeps a hunk cursor for its own line staging, so
 * `h`/`l` move it — but `j`/`k` scroll, which is why they work on a branch's commit graph too.
 */
describe("main view scrolling", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  /** A repo whose working-tree diff is far taller than the main pane. */
  async function harnessWithTallDiff(): Promise<ShellHarness> {
    const created = await createShellHarness({
      commits: ["first commit"],
      setup: async (repository) => {
        await repository.write("tall.txt", Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n") + "\n")
        await repository.git(["add", "tall.txt"])
        await repository.git(["commit", "-m", "add tall file"])
        await repository.write("tall.txt", Array.from({ length: 400 }, (_, index) => `changed ${index}`).join("\n") + "\n")
      },
    })
    await created.pressKey("0")
    await created.flush()
    return created
  }

  const scrollY = (harness: ShellHarness): number => harness.app.view!.mainScrollY

  test("j and k scroll one line at a time with the main view focused", async () => {
    harness = await harnessWithTallDiff()
    expect(scrollY(harness)).toBe(0)

    await harness.pressKey("j")
    expect(scrollY(harness)).toBe(1)
    await harness.pressKey("j")
    await harness.pressKey("j")
    expect(scrollY(harness)).toBe(3)

    await harness.pressKey("k")
    expect(scrollY(harness)).toBe(2)
  })

  test("down and up arrows do the same as j and k", async () => {
    harness = await harnessWithTallDiff()
    await harness.pressKey("ARROW_DOWN")
    await harness.pressKey("ARROW_DOWN")
    expect(scrollY(harness)).toBe(2)
    await harness.pressKey("ARROW_UP")
    expect(scrollY(harness)).toBe(1)
  })

  test("scrolling is clamped, so k at the top and j at the bottom go nowhere", async () => {
    harness = await harnessWithTallDiff()
    await harness.pressKey("k")
    expect(scrollY(harness)).toBe(0)

    await harness.pressKey(">")
    await harness.flush()
    const bottom = scrollY(harness)
    expect(bottom).toBeGreaterThan(0)
    await harness.pressKey("j")
    expect(scrollY(harness)).toBe(bottom)
  })

  test("focused page and jump navigation move the main line cursor", async () => {
    harness = await harnessWithTallDiff()
    const view = harness.app.view!
    const before = getMainDiffLineRangeState(view.mainPane)!.selectedIndex
    await harness.pressKey(".")
    const afterPage = getMainDiffLineRangeState(view.mainPane)!.selectedIndex
    expect(afterPage).toBeGreaterThan(before)
    await harness.pressKey(">")
    const afterBottom = getMainDiffLineRangeState(view.mainPane)!
    expect(afterBottom.selectedIndex).toBe(afterBottom.lineCount - 1)
    await harness.pressKey("<")
    expect(getMainDiffLineRangeState(view.mainPane)!.selectedIndex).toBe(0)
    expect(diffLineSelectionRange(getMainDiffLineRangeState(view.mainPane)!)).toEqual({ startIndex: 0, endIndex: 0 })
  })

  test("a branch's commit graph scrolls with j and k, though it is no diff at all", async () => {
    harness = await createShellHarness({
      commits: Array.from({ length: 40 }, (_, index) => `commit number ${index}`),
    })
    await harness.pressKey("3")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()
    expect(harness.app.view!.mainContent?.source).toBe("local-branch")

    await harness.pressKey("0")
    await harness.flush()
    expect(scrollY(harness)).toBe(0)

    await harness.pressKey("j")
    await harness.pressKey("j")
    await harness.pressKey("j")
    expect(scrollY(harness)).toBe(3)
    await harness.pressKey("k")
    expect(scrollY(harness)).toBe(2)
  })

  test("h and l still move the hunk cursor, which is what stages lines", async () => {
    harness = await createShellHarness({
      commits: ["first commit"],
      setup: async (repository) => {
        const lines = Array.from({ length: 300 }, (_, index) => `line ${index}`)
        await repository.write("a.txt", `${lines.join("\n")}\n`)
        await repository.git(["add", "a.txt"])
        await repository.git(["commit", "-m", "add a"])
        // An edit every tenth line, so the patch is a long run of separate hunks and later ones
        // sit well below the viewport.
        for (let index = 5; index < 300; index += 10) lines[index] = `edited ${index}`
        await repository.write("a.txt", `${lines.join("\n")}\n`)
      },
    })
    await harness.pressKey("0")
    await harness.flush()
    // A freshly installed patch has no cursor yet; the first move lands on the first hunk.
    expect(harness.app.view!.mainCursorTarget).toBeUndefined()

    await harness.pressKey("l")
    await harness.flush()
    expect(harness.app.view!.mainCursorTarget?.hunkIndex).toBe(0)

    for (let press = 0; press < 14; press++) await harness.pressKey("l")
    await harness.flush()
    expect(harness.app.view!.mainCursorTarget?.hunkIndex).toBe(14)
    // A hunk below the viewport is revealed, which fourteen presses of j would not have reached.
    expect(scrollY(harness)).toBeGreaterThan(14)

    await harness.pressKey("h")
    await harness.flush()
    expect(harness.app.view!.mainCursorTarget?.hunkIndex).toBe(13)
  })

  test("J, K, ctrl+d, ctrl+u, pagedown and pageup all scroll by lazygit's scrollHeight", async () => {
    expect(MAIN_SCROLL_HEIGHT).toBe(2)
    harness = await harnessWithTallDiff()
    // From the Status panel, not the main pane: these six are global in lazygit, and focusing
    // Status leaves the main view showing whatever it already held.
    await harness.pressKey("1")
    await harness.flush()

    const PAGE_DOWN = "\u001b[6~"
    const PAGE_UP = "\u001b[5~"
    for (const [down, up, modifiers] of [["J", "K", { shift: true }], [PAGE_DOWN, PAGE_UP, undefined]] as const) {
      const start = scrollY(harness)
      await harness.pressKey(down, modifiers)
      expect(scrollY(harness)).toBe(start + MAIN_SCROLL_HEIGHT)
      await harness.pressKey(up, modifiers)
      expect(scrollY(harness)).toBe(start)
    }

    const start = scrollY(harness)
    await harness.pressKey("d", { ctrl: true })
    expect(scrollY(harness)).toBe(start + MAIN_SCROLL_HEIGHT)
    await harness.pressKey("u", { ctrl: true })
    expect(scrollY(harness)).toBe(start)
  })

  test("with the main view focused, comma and period scroll a page and angle brackets jump to the ends", async () => {
    harness = await harnessWithTallDiff()
    const page = harness.app.view!.mainPageDelta
    expect(page).toBeGreaterThan(MAIN_SCROLL_HEIGHT)

    await harness.pressKey(".")
    expect(scrollY(harness)).toBe(page)
    await harness.pressKey(",")
    expect(scrollY(harness)).toBe(0)

    await harness.pressKey(">")
    await harness.flush()
    expect(scrollY(harness)).toBe(harness.app.view!.mainPane.maxScrollY())
    await harness.pressKey("<")
    await harness.flush()
    expect(scrollY(harness)).toBe(0)
  })

  test("comma and period still page a side panel's list when that panel has focus", async () => {
    harness = await createShellHarness({
      commits: Array.from({ length: 30 }, (_, index) => `commit number ${index}`),
    })
    await harness.pressKey("4")
    await harness.flush()
    const first = harness.app.view!.commitsSelectedOid
    await harness.pressKey(".")
    await harness.flush()
    expect(harness.app.view!.commitsSelectedOid).not.toBe(first)
    // And the main view did not move: the key belonged to the focused list.
    expect(scrollY(harness)).toBe(0)
  })
})

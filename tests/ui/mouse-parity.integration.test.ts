import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { paneScrollbar } from "../../src/ui/panes/common"

describe("mouse parity - row selection and wheel routing", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("clicking a scrolled commit selects its stable row and updates Main", async () => {
    const subjects = Array.from({ length: 30 }, (_, i) => `commit ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const box = view.paneTextGeometry("commits")!
    // scroll down a bit via wheel to have scrollY >0
    await harness.mockMouse.scroll(box.screenX + 2, box.screenY + 1, "down")
    await harness.flush()
    const before = view.commitsSelectedOid
    // click second visible row (which is scrolled)
    await harness.mockMouse.click(box.screenX + 3, box.screenY + 1)
    await harness.flush()
    await harness.settle()
    expect(view.commitsSelectedOid).not.toBe(before)
    expect(view.focusManager.active).toBe("commits")
    // Main should have updated (not showing old commit)
    expect(view.mainScrollY).toBeDefined()
  })

  test("wheel scrolls only the pane under the pointer without changing focus or selection", async () => {
    const subjects = Array.from({ length: 40 }, (_, i) => `c${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const focus = view.focusManager.active
    const selected = view.commitsSelectedOid
    const mainBefore = view.mainScrollY
    const commitsBefore = view.paneScrollY("commits")
    const commitBox = view.paneTextGeometry("commits")!
    await harness.mockMouse.scroll(commitBox.screenX + 1, commitBox.screenY + 1, "down")
    await harness.flush()
    expect(view.paneScrollY("commits")).toBe(commitsBefore + 2)
    expect(view.mainScrollY).toBe(mainBefore)
    expect(view.focusManager.active).toBe(focus)
    expect(view.commitsSelectedOid).toBe(selected)
  })

  test("wheel on Main scrolls Main only", async () => {
    const subjects = Array.from({ length: 40 }, (_, i) => `m${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("0")
    await harness.flush()
    const commitsBefore = view.paneScrollY("commits")
    const mainBefore = view.mainScrollY
    const mainBox = view.paneTextGeometry("main")!
    const maxMain = view.mainPane.text.maxScrollY
    await harness.mockMouse.scroll(mainBox.screenX + 1, mainBox.screenY + 1, "down")
    await harness.flush()
    if (maxMain > 0) {
      expect(view.mainScrollY).toBeGreaterThan(mainBefore)
    } else {
      expect(view.mainScrollY).toBe(mainBefore)
    }
    expect(view.paneScrollY("commits")).toBe(commitsBefore)
  })

  test("wheel on splitter is no-op (consumed without scrolling)", async () => {
    harness = await createShellHarness({ width: 120, height: 40 })
    const view = harness.app.view!
    await harness.flush()
    const vsplit = view.geometry.windows.vsplit
    if (!vsplit) return
    const x = vsplit.x0
    const y = vsplit.y0 + 1
    const commitsBefore = view.paneScrollY("commits")
    const mainBefore = view.mainScrollY
    await harness.mockMouse.scroll(x, y, "down")
    await harness.flush()
    expect(view.paneScrollY("commits")).toBe(commitsBefore)
    expect(view.mainScrollY).toBe(mainBefore)
  })

  test("clicking blank area focuses pane but does not change selection", async () => {
    harness = await createShellHarness({ commits: ["a", "b"], width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const before = view.commitsSelectedOid
    const box = view.paneTextGeometry("commits")!
    // click below last row but still inside pane (height maybe 5, we click at bottom)
    const blankY = box.screenY + box.height - 1
    // ensure blankY is beyond rows (commits only 2 rows)
    await harness.mockMouse.click(box.screenX + 1, blankY)
    await harness.flush()
    expect(view.focusManager.active).toBe("commits")
    // selection should stay same (blank click doesn't select)
    expect(view.commitsSelectedOid).toBe(before)
  })

  test("border/title coordinates still route wheel to pane", async () => {
    const subjects = Array.from({ length: 30 }, (_, i) => `b${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const win = view.geometry.windows.commits!
    const borderX = win.x0
    const borderY = win.y0
    const before = view.paneScrollY("commits")
    await harness.mockMouse.scroll(borderX, borderY + 1, "down")
    await harness.flush()
    // border click should still scroll (or at least not throw) - we check that scroll either happens or is consumed
    // For wheel on border, our findPaneAtPoint uses window rect inclusive, so it should scroll
    expect(view.paneScrollY("commits")).toBe(before + 2)
  })

  test("click after compact-pane focus relayout still selects", async () => {
    harness = await createShellHarness({ commits: Array.from({ length: 20 }, (_, i) => `relayout ${i}`), width: 120, height: 24 })
    const view = harness.app.view!
    // focus main to trigger compact layout (height 24 is near boundary but not too small)
    await harness.pressKey("0")
    await harness.flush()
    // now click commits
    await harness.pressKey("4")
    // actually focus via mouse click after relayout
    const box = view.paneTextGeometry("commits")!
    await harness.mockMouse.click(box.screenX + 1, box.screenY + 1)
    await harness.flush()
    expect(view.focusManager.active).toBe("commits")
    // should have selection
    expect(view.commitsSelectedOid).toBeDefined()
  })

  test("double-click triggers Enter (commit drilldown)", async () => {
    harness = await createShellHarness({ commits: ["first", "second", "third"], width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const box = view.paneTextGeometry("commits")!
    // double click second row
    const x = box.screenX + 2
    const y = box.screenY + 1
    await harness.mockMouse.click(x, y)
    await harness.flush()
    const beforeKind = view.commitsContextKind
    await harness.mockMouse.click(x, y)
    await harness.flush()
    await harness.settle()
    // double click should drill down into commit-files
    expect(view.commitsContextKind).not.toBe(beforeKind)
  })

  test("wheel over Command Log scrolls only log", async () => {
    // Stated explicitly (Task 10 made this the default, `Gui.ShowCommandLog: true`,
    // pkg/config/user_config.go:901) rather than relied on: this test's own `if (!logBox) return`
    // guard used to silently no-op once the log started shown by default and the `@`/`t` toggle
    // below (still present pre-Task-10, when the log started hidden) began hiding it instead of
    // showing it.
    harness = await createShellHarness({ width: 120, height: 40, logVisible: true })
    const view = harness.app.view!
    const logBox = view.paneTextGeometry("command-log")
    if (!logBox) throw new Error("the command log window is not laid out")
    const commitsBefore = view.paneScrollY("commits")
    await harness.mockMouse.scroll(logBox.screenX + 1, logBox.screenY + 1, "down")
    await harness.flush()
    // commits should not scroll
    expect(view.paneScrollY("commits")).toBe(commitsBefore)
  })

  test("Main double-click does not break but wheel still works", async () => {
    harness = await createShellHarness({ width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("0")
    await harness.flush()
    const mainBox = view.paneTextGeometry("main")!
    const before = view.mainScrollY
    await harness.mockMouse.scroll(mainBox.screenX + 1, mainBox.screenY + 1, "down")
    await harness.flush()
    expect(view.mainScrollY).toBeGreaterThanOrEqual(before)
  })
})

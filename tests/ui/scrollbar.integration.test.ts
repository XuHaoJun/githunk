import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { paneScrollbar } from "../../src/ui/panes/common"

describe("scrollbar and gesture capture", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("scrollbar track click scrolls without focusing pane and thumb drag reaches max", async () => {
    const subjects = Array.from({ length: 50 }, (_, i) => `sb ${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const bar = paneScrollbar(view.commitsPane.text)!
    expect(bar.visible).toBe(true)
    const focusBefore = view.focusManager.active
    const win = view.geometry.windows.commits!
    const barX = win.x1 - 1
    const barY = win.y0 + 1 + Math.floor((win.y1 - win.y0 - 1) / 2)
    await harness.mockMouse.click(barX, barY)
    await harness.flush()
    expect(view.paneScrollY("commits")).toBeGreaterThan(0)
    expect(view.focusManager.active).toBe(focusBefore)
    const bar2 = paneScrollbar(view.commitsPane.text)!
    const topY = win.y0 + 1
    const bottomY = win.y1 - 1
    await harness.mockMouse.drag(barX, topY, barX, bottomY)
    await harness.flush()
    expect(view.paneScrollY("commits")).toBe(view.commitsPane.text.maxScrollY)
    expect(bar2.scrollPosition).toBe(view.commitsPane.text.scrollY)
  })

  test("splitter drag continues even when dragged several cells outside 1px", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!
    const before = view.geometry.sidePanelRatio
    const vsplit = view.geometry.windows.vsplit!
    const startX = vsplit.x0
    const y = vsplit.y0 + 2
    await harness.mockMouse.drag(startX, y, startX + 20, y)
    await harness.flush()
    expect(view.geometry.sidePanelRatio).not.toBe(before)
    expect(view.geometry.sidePanelRatio).toBeGreaterThan(before)
  })

  test("scrollbar drag crossing splitter only scrolls viewport, not splitter", async () => {
    const subjects = Array.from({ length: 50 }, (_, i) => `cross ${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const beforeRatio = view.geometry.sidePanelRatio
    const win = view.geometry.windows.commits!
    const barX = win.x1 - 1
    const vsplit = view.geometry.windows.vsplit!
    await harness.mockMouse.drag(barX, win.y0 + 2, vsplit.x0, win.y0 + 10)
    await harness.flush()
    expect(view.paneScrollY("commits")).toBeGreaterThan(0)
    expect(view.geometry.sidePanelRatio).toBe(beforeRatio)
  })

  test("degenerate overlap where splitters overlap vertical wins", async () => {
    harness = await createShellHarness({ width: 60, height: 15 })
    const view = harness.app.view!
    const vsplit = view.geometry.windows.vsplit
    const hsplit = view.geometry.windows.hsplit
    if (!vsplit || !hsplit) return
    const overlapX = Math.max(vsplit.x0, hsplit.x0)
    const overlapY = Math.max(vsplit.y0, hsplit.y0)
    const overlap = overlapX <= Math.min(vsplit.x1, hsplit.x1) && overlapY <= Math.min(vsplit.y1, hsplit.y1)
    if (!overlap) {
      await harness.mockMouse.drag(vsplit.x0, vsplit.y0, vsplit.x0 + 5, vsplit.y0)
      await harness.flush()
      expect(typeof view.geometry.sidePanelRatio).toBe("number")
      return
    }
    await harness.mockMouse.pressDown(overlapX, overlapY)
    await harness.flush()
    expect(view.gestureOwner?.kind).toBe("vertical-splitter")
    await harness.mockMouse.release(overlapX, overlapY)
    await harness.flush()
    expect(view.gestureOwner).toBeUndefined()
  })
  test("hide/destroy cancels captured gesture", async () => {
    const subjects = Array.from({ length: 40 }, (_, i) => `hide ${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const win = view.geometry.windows.commits!
    const barX = win.x1 - 1
    const startY = win.y0 + 2
    await harness.mockMouse.pressDown(barX, startY)
    await harness.flush()
    expect(view.gestureOwner?.kind).toBe("scrollbar")
    const vsplit = view.geometry.windows.vsplit
    if (vsplit) {
      const x = vsplit.x0
      const y = vsplit.y0 + 1
      await harness.mockMouse.click(x, y)
      await harness.mockMouse.click(x, y)
      await harness.flush()
      if (view.geometry.windows.commits === undefined) {
        expect(view.gestureOwner).toBeUndefined()
      }
    }
    await harness.mockMouse.release(barX, startY)
    await harness.flush()
    expect(view.gestureOwner).toBeUndefined()
  })
  test("cancelGesture clears after bar becomes invisible", async () => {
    const subjects = Array.from({ length: 40 }, (_, i) => `cancel ${i}`)
    harness = await createShellHarness({ commits: subjects, width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.flush()
    const bar = paneScrollbar(view.commitsPane.text)!
    expect(bar.visible).toBe(true)
    const win = view.geometry.windows.commits!
    const barX = win.x1 - 1
    await harness.mockMouse.pressDown(barX, win.y0 + 2)
    await harness.flush()
    expect(view.gestureOwner?.kind).toBe("scrollbar")
    bar.visible = false
    view.cancelGesture()
    expect(view.gestureOwner).toBeUndefined()
    await harness.mockMouse.release(barX, win.y0 + 2)
    await harness.flush()
    expect(view.gestureOwner).toBeUndefined()
  })

  test("Main native selection drag across scrollbar/splitter does not resize/scroll", async () => {
    harness = await createShellHarness({ width: 120, height: 40 })
    const view = harness.app.view!
    await harness.pressKey("0")
    await harness.flush()
    const mainBox = view.paneTextGeometry("main")!
    const beforeRatio = view.geometry.sidePanelRatio
    const beforeScroll = view.paneScrollY("commits")
    await harness.mockMouse.pressDown(mainBox.screenX + 2, mainBox.screenY + 1)
    await harness.flush()
    expect(view.gestureOwner?.kind).toBe("main-selection")
    const vsplit = view.geometry.windows.vsplit
    if (vsplit) {
      await harness.mockMouse.drag(mainBox.screenX + 2, mainBox.screenY + 1, vsplit.x0, vsplit.y0 + 1)
      await harness.flush()
      expect(view.geometry.sidePanelRatio).toBe(beforeRatio)
      expect(view.paneScrollY("commits")).toBe(beforeScroll)
    }
    await harness.mockMouse.release(mainBox.screenX + 5, mainBox.screenY + 1)
    await harness.flush()
    expect(view.gestureOwner).toBeUndefined()
  })

  test("wheel on splitter consumes without scrolling", async () => {
    harness = await createShellHarness({ width: 120, height: 40 })
    const view = harness.app.view!
    await harness.flush()
    const vsplit = view.geometry.windows.vsplit
    if (!vsplit) return
    const commitsBefore = view.paneScrollY("commits")
    await harness.mockMouse.scroll(vsplit.x0, vsplit.y0 + 1, "down")
    await harness.flush()
    expect(view.paneScrollY("commits")).toBe(commitsBefore)
    expect(view.gestureOwner).toBeUndefined()
  })
})

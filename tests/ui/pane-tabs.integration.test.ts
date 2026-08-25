import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes, parseColor } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { paneTabsPlainTitle } from "../../src/ui/pane-tabs"
import { SELECTED_LINE_BG, TAB_ACTIVE_FG } from "../../src/ui/theme"

const BRANCHES_TABS = ["Local Branches", "Remotes", "Tags"] as const

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

describe("shared pane tab strip on screen", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("panel 3's border row shows lazygit's strip with the active tab green and bold", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    await harness.flush()
    const win = harness.app.view!.geometry.windows.branches!
    const expected = paneTabsPlainTitle({ jumpKey: "3", tabs: BRANCHES_TABS })
    const borderRow = harness.frame().split("\n")[win.y0]!
    expect(borderRow.slice(win.x0 + 2, win.x0 + 2 + expected.length)).toBe(expected)

    const activeStart = win.x0 + 2 + "[3]─".length
    const spans = spansAt(harness, win.y0, activeStart, activeStart + "Local Branches".length - 1)
    const activeGreen = parseColor(TAB_ACTIVE_FG).toInts()
    const active = spans.find((s) => s.text.includes("Local Branches"))
    expect(active).toBeDefined()
    expect(active!.fg).toEqual(activeGreen)
    expect(active!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    // Inactive tabs are not green.
    const remotesStart = activeStart + "Local Branches - ".length
    const remotes = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(remotes.every((s) => JSON.stringify(s.fg) !== JSON.stringify(activeGreen))).toBe(true)
  })

  test("cycling tabs and losing focus repaint the strip", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.flush()
    const win = harness.app.view!.geometry.windows.branches!
    const activeGreen = parseColor(TAB_ACTIVE_FG).toInts()
    const remotesStart = win.x0 + 2 + "[3]─Local Branches - ".length
    const remotes = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(remotes.some((s) => JSON.stringify(s.fg) === JSON.stringify(activeGreen))).toBe(true)

    // Focus elsewhere: gocui's drawTitle only highlights while IsFocused().
    await harness.pressKey("1")
    await harness.flush()
    const unfocused = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(unfocused.every((s) => JSON.stringify(s.fg) !== JSON.stringify(activeGreen))).toBe(true)
    // The strip text itself stays on screen.
    const borderRow = harness.frame().split("\n")[win.y0]!
    expect(borderRow).toContain("[3]─Local Branches - Remotes - Tags")
  })

  test("clicking a tab in the title row switches to it; clicking a separator does nothing", async () => {
    harness = await createShellHarness()
    await harness.pressKey("1")
    await harness.flush()
    const win = harness.app.view!.geometry.windows.branches!
    const y = win.y0
    // "Tags" starts 33 columns right of the pane's left edge.
    await harness.mockMouse.click(win.x0 + 33, y)
    await harness.flush()
    expect(harness.app.view!.activeBranchesTab).toBe("tags")
    expect(harness.app.view!.focusManager.active).toBe("branches")

    // Offset 20..22 is the first " - " separator.
    await harness.mockMouse.click(win.x0 + 21, y)
    await harness.flush()
    expect(harness.app.view!.activeBranchesTab).toBe("tags")

    await harness.mockMouse.click(win.x0 + 6, y)
    await harness.flush()
    expect(harness.app.view!.activeBranchesTab).toBe("branches")
  })

  test("the selected row's background is lazygit's blue rather than #0000FF", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    await harness.pressKey("4")
    await harness.flush()
    const geometry = harness.paneTextGeometry("commits")!
    const spans = spansAt(harness, geometry.screenY, geometry.screenX, geometry.screenX + geometry.width - 1)
    const expectedBg = parseColor(SELECTED_LINE_BG).toInts()
    const highlighted = spans.filter((s) => JSON.stringify(s.bg) === JSON.stringify(expectedBg))
    expect(highlighted.length).toBeGreaterThan(0)
    expect(spans.every((s) => JSON.stringify(s.bg) !== JSON.stringify([0, 0, 255, 255]))).toBe(true)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes, type RGBA } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { paneTabsPlainTitle } from "../../src/ui/pane-tabs"

const BRANCHES_TABS = ["Local Branches", "Remotes", "Tags"] as const

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

    const active = spans.find((s) => s.text.includes("Local Branches"))
    expect(active).toBeDefined()
    expect(isIndexed(active!.fg, 2)).toBe(true)
    expect(active!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    // Inactive tabs are not the active ANSI green.
    const remotesStart = activeStart + "Local Branches - ".length
    const remotes = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(remotes.every((s) => !isIndexed(s.fg, 2))).toBe(true)
  })

  test("cycling tabs and losing focus repaint the strip", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    await harness.pressKey("]")
    const win = harness.app.view!.geometry.windows.branches!
    const remotesStart = win.x0 + 2 + "[3]─Local Branches - ".length
    const remotes = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(remotes.some((s) => isIndexed(s.fg, 2))).toBe(true)

    // Focus elsewhere: gocui's drawTitle only highlights while IsFocused().
    await harness.pressKey("1")
    await harness.flush()
    const unfocused = spansAt(harness, win.y0, remotesStart, remotesStart + "Remotes".length - 1)
    expect(unfocused.every((s) => !isIndexed(s.fg, 2))).toBe(true)
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

  test("the selected row's background keeps lazygit's ANSI blue intent", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    await harness.pressKey("4")
    await harness.flush()
    const geometry = harness.paneTextGeometry("commits")!
    const spans = spansAt(harness, geometry.screenY, geometry.screenX, geometry.screenX + geometry.width - 1)
    const highlighted = spans.filter((s) => isIndexed(s.bg, 4))
    expect(highlighted.length).toBeGreaterThan(0)
    expect(spans.every((s) => !isIndexed(s.bg, 12))).toBe(true)
  })
})

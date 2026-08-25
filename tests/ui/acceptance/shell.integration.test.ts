import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../../helpers/shell-harness"
import { MIN_LEFT_WIDTH } from "../../../src/ui/layout"

describe("review shell acceptance", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("the commits pane lists the branch's commits", async () => {
    harness = await createShellHarness({ commits: ["oldest work", "middle work", "newest work"] })
    await harness.pressKey("4")
    const frame = harness.frame()
    expect(frame).toContain("newest work")
    expect(frame).toContain("oldest work")
    expect(frame).not.toContain("No commits")
  })

  test("the bottom row always says which keys the focused pane accepts", async () => {
    // The stash needs an entry for its apply binding to be available (and therefore hinted),
    // so this harness creates one — the files and branches hints need no such setup.
    harness = await createShellHarness({ stash: true })
    for (const [key, expected] of [["2", "stage: space"], ["3", "checkout: space"], ["5", "apply: space"]] as const) {
      await harness.pressKey(key)
      expect(harness.frame()).toContain(expected)
    }
  })

  test("the side region scales with the terminal instead of staying at thirty columns", async () => {
    harness = await createShellHarness({ width: 240, height: 40 })
    expect(harness.app.view!.geometry.sideWidth).toBeGreaterThan(60)
    await harness.resize(80, 40)
    expect(harness.app.view!.geometry.sideWidth).toBeGreaterThanOrEqual(MIN_LEFT_WIDTH)
    expect(harness.app.view!.geometry.sideWidth).toBeLessThan(60)
  })

  test("the stash pane keeps its height when it is focused", async () => {
    harness = await createShellHarness({ stash: true, height: 40 })
    await harness.pressKey("2")
    const before = harness.app.view!.geometry.windows.stash!
    const heightBeforeFocus = before.y1 - before.y0 + 1
    expect(heightBeforeFocus).toBe(3)
    await harness.pressKey("5")
    const focused = harness.app.view!.geometry.windows.stash!
    expect(focused.y1 - focused.y0 + 1).toBeGreaterThan(heightBeforeFocus)
  })

  test("hjkl navigates: h and l between panes, j and k within one", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.pressKey("l")
    await harness.pressKey("l")
    expect(view.focusManager.active).toBe("commits")
    await harness.pressKey("j")
    expect(harness.frame()).toContain("beta")
    await harness.pressKey("h")
    expect(view.focusManager.active).toBe("branches")
  })

  test("both regions are adjustable: drag the divider, and zoom with plus", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!

    const before = view.geometry.sideWidth
    await harness.drag(before, 10, 100, 10)
    expect(view.geometry.sideWidth).toBeGreaterThan(before)

    await harness.pressKey("0")
    await harness.pressKey("+")
    expect(view.geometry.sideWidth).toBe(0)
    await harness.pressKey("4")
    await harness.pressKey("+")
    expect(view.geometry.windows.main).toBeUndefined()
  })

  test("a resize never corrupts the layout", async () => {
    harness = await createShellHarness({ width: 200, height: 50 })
    for (const [width, height] of [[100, 30], [70, 20], [200, 50], [60, 14]] as const) {
      await harness.resize(width, height)
      const geometry = harness.app.view!.geometry
      expect(geometry.terminalWidth).toBe(width)
      expect(geometry.terminalHeight).toBe(height)
      for (const dimensions of Object.values(geometry.windows)) {
        expect(dimensions.x0).toBeGreaterThanOrEqual(0)
        expect(dimensions.y0).toBeGreaterThanOrEqual(0)
        expect(dimensions.x1).toBeLessThan(width)
        expect(dimensions.y1).toBeLessThan(height)
      }
    }
  })
})

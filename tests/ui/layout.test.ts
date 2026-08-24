import { describe, expect, test } from "bun:test"
import {
  computeLayout,
  heightOf,
  logHeightForMouseY,
  nextScreenMode,
  previousScreenMode,
  ratioForMouseX,
  widthOf,
  DEFAULT_SIDE_PANEL_RATIO,
  MIN_LEFT_WIDTH,
  MIN_MAIN_WIDTH,
  SIDE_WINDOWS,
  STATUS_PANE_HEIGHT,
  FOLDED_PANE_HEIGHT,
} from "../../src/ui/layout"

describe("computeLayout side region", () => {
  test("sizes the side region by ratio rather than a fixed column count", () => {
    const layout = computeLayout({ width: 200, height: 40 })
    expect(layout.sidePanelRatio).toBe(DEFAULT_SIDE_PANEL_RATIO)
    expect(layout.sideWidth).toBe(Math.round(200 * DEFAULT_SIDE_PANEL_RATIO))
    // Each side pane spans the full side width, so any of them measures it.
    expect(widthOf(layout.windows.files)).toBe(layout.sideWidth)
  })

  test("honours an explicit ratio", () => {
    expect(computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.5 }).sideWidth).toBe(60)
  })

  test("clamps the ratio to the side and main minimums", () => {
    const tiny = computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.01 })
    expect(tiny.sideWidth).toBe(MIN_LEFT_WIDTH)
    const huge = computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.99 })
    expect(widthOf(huge.windows.main)).toBe(MIN_MAIN_WIDTH)
  })

  test("partitions the width exactly across side, splitter and main", () => {
    const layout = computeLayout({ width: 137, height: 41 }, { logVisible: true })
    expect(layout.sideWidth + widthOf(layout.windows.vsplit) + widthOf(layout.windows.main)).toBe(137)
  })
})

describe("computeLayout left stack", () => {
  test("pins the status pane and folds an unfocused stash", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "files" })
    expect(heightOf(layout.windows.status)).toBe(STATUS_PANE_HEIGHT)
    expect(heightOf(layout.windows.stash)).toBe(FOLDED_PANE_HEIGHT)
  })

  test("expands the focused pane and never the status pane", () => {
    const focused = computeLayout({ width: 120, height: 40 }, { focus: "commits" })
    expect(heightOf(focused.windows.commits)).toBeGreaterThan(heightOf(focused.windows.files))
    expect(heightOf(focused.windows.status)).toBe(STATUS_PANE_HEIGHT)
  })

  test("expands the stash pane when it is focused", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "stash" })
    expect(heightOf(layout.windows.stash)).toBeGreaterThan(FOLDED_PANE_HEIGHT)
  })

  test("gives every pane an equal share when the accordion is disabled", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", accordion: false })
    expect(heightOf(layout.windows.commits)).toBe(heightOf(layout.windows.files))
  })

  test("partitions the side height exactly across the five panes", () => {
    for (const height of [40, 33, 26, 19, 12]) {
      const layout = computeLayout({ width: 120, height }, { focus: "files", hintsVisible: true })
      const total = SIDE_WINDOWS.reduce((sum, name) => sum + heightOf(layout.windows[name]), 0)
      expect(total).toBe(height - 1)
    }
  })

  test("squashes unfocused panes on a short terminal and keeps the focused one usable", () => {
    const short = computeLayout({ width: 120, height: 24 }, { focus: "files" })
    expect(heightOf(short.windows.branches)).toBe(FOLDED_PANE_HEIGHT)
    expect(heightOf(short.windows.files)).toBeGreaterThan(FOLDED_PANE_HEIGHT)

    const shorter = computeLayout({ width: 120, height: 18 }, { focus: "files" })
    expect(heightOf(shorter.windows.branches)).toBe(1)
    expect(heightOf(shorter.windows.files)).toBeGreaterThan(1)
  })

  test("keeps a weighted absorber when focus is on the main pane", () => {
    for (const height of [24, 18]) {
      const layout = computeLayout({ width: 120, height }, { focus: "main" })
      const total = SIDE_WINDOWS.reduce((sum, name) => sum + heightOf(layout.windows[name]), 0)
      expect(total).toBe(height - 1)
    }
  })
})

describe("computeLayout command log", () => {
  test("omits the log and its splitter when hidden", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { logVisible: false })
    expect(layout.windows.log).toBeUndefined()
    expect(layout.windows.hsplit).toBeUndefined()
    expect(layout.logHeight).toBe(0)
  })

  test("partitions the main column exactly when the log is shown", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { logVisible: true, logHeight: 8 })
    expect(layout.logHeight).toBe(8)
    expect(heightOf(layout.windows.main) + heightOf(layout.windows.hsplit) + layout.logHeight).toBe(39)
  })

  test("clamps an oversized log request", () => {
    const layout = computeLayout({ width: 120, height: 20 }, { logVisible: true, logHeight: 999 })
    expect(heightOf(layout.windows.main)).toBeGreaterThanOrEqual(8)
  })
})

describe("computeLayout hints row", () => {
  test("reserves one row and right-aligns the status segment", () => {
    const layout = computeLayout({ width: 100, height: 40 }, { hintsVisible: true, statusWidth: 12 })
    expect(heightOf(layout.windows.hints)).toBe(1)
    expect(widthOf(layout.windows.info)).toBe(12)
    expect(layout.windows.info?.x1).toBe(99)
    expect(widthOf(layout.windows.hints)).toBe(88)
  })

  test("reclaims the row when hints are hidden", () => {
    const layout = computeLayout({ width: 100, height: 40 }, { hintsVisible: false, logVisible: false })
    expect(layout.windows.hints).toBeUndefined()
    expect(heightOf(layout.windows.main)).toBe(40)
  })
})

describe("computeLayout screen modes", () => {
  test("collapses the side region in half and full mode when main has focus", () => {
    for (const screenMode of ["half", "full"] as const) {
      const layout = computeLayout({ width: 120, height: 40 }, { focus: "main", screenMode })
      expect(layout.sideWidth).toBe(0)
      expect(layout.windows.files).toBeUndefined()
      expect(layout.windows.vsplit).toBeUndefined()
      expect(widthOf(layout.windows.main)).toBe(120)
    }
  })

  test("half mode with side focus splits the width and shows only the focused pane", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", screenMode: "half" })
    expect(layout.sideWidth).toBe(60)
    expect(heightOf(layout.windows.commits)).toBeGreaterThan(0)
    expect(heightOf(layout.windows.files)).toBe(0)
  })

  test("full mode with side focus collapses main", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", screenMode: "full" })
    expect(layout.windows.main).toBeUndefined()
    expect(layout.windows.vsplit).toBeUndefined()
    expect(widthOf(layout.windows.commits)).toBe(120)
  })

  test("cycles forward and backward without wrapping past the ends", () => {
    expect(nextScreenMode("normal")).toBe("half")
    expect(nextScreenMode("half")).toBe("full")
    expect(nextScreenMode("full")).toBe("full")
    expect(previousScreenMode("full")).toBe("half")
    expect(previousScreenMode("half")).toBe("normal")
    expect(previousScreenMode("normal")).toBe("normal")
  })
})

describe("computeLayout robustness", () => {
  test("reports terminals that cannot host the normal layout", () => {
    expect(computeLayout({ width: 58, height: 40 }, { logVisible: false }).tooSmall).toBe(true)
    expect(computeLayout({ width: 120, height: 11 }, { logVisible: true }).tooSmall).toBe(true)
    expect(computeLayout({ width: 120, height: 40 }, { logVisible: true }).tooSmall).toBe(false)
  })

  test("never produces a negative or empty main region at tiny sizes", () => {
    for (const width of [1, 2, 10, 20, 59]) {
      for (const height of [1, 2, 5, 10, 12]) {
        const layout = computeLayout({ width, height }, { logVisible: true, logHeight: 8 })
        expect(widthOf(layout.windows.main)).toBeGreaterThanOrEqual(1)
        expect(heightOf(layout.windows.main)).toBeGreaterThanOrEqual(1)
        for (const dimensions of Object.values(layout.windows)) {
          expect(dimensions.x0).toBeGreaterThanOrEqual(0)
          expect(dimensions.y0).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  test("tolerates non-finite terminal sizes", () => {
    const layout = computeLayout({ width: Number.NaN, height: Number.POSITIVE_INFINITY })
    expect(layout.terminalWidth).toBeGreaterThanOrEqual(1)
    expect(layout.terminalHeight).toBeGreaterThanOrEqual(1)
  })
})

describe("mouse mapping", () => {
  test("maps a drag x coordinate to a ratio of the terminal width", () => {
    const layout = computeLayout({ width: 200, height: 40 })
    expect(ratioForMouseX(layout, 50)).toBeCloseTo(0.25, 5)
    expect(ratioForMouseX(layout, -10)).toBe(0)
    expect(ratioForMouseX(layout, 999)).toBe(1)
  })

  test("maps a drag y coordinate to a command log height", () => {
    const layout = computeLayout({ width: 120, height: 41 }, { logVisible: true, logHeight: 8 })
    expect(logHeightForMouseY(layout, 30)).toBe(9)
  })
})

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
  test("pins the status pane", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "files", currentSideWindow: "files" })
    expect(heightOf(layout.windows.status)).toBe(STATUS_PANE_HEIGHT)
  })

  test("folds an unfocused stash to three rows and expands focused stash", () => {
    const unfocused = computeLayout({ width: 120, height: 40 }, { focus: "commits", currentSideWindow: "commits" })
    expect(heightOf(unfocused.windows.stash)).toBe(3)
    const focused = computeLayout({ width: 120, height: 40 }, { focus: "stash", currentSideWindow: "stash" })
    expect(heightOf(focused.windows.stash)).toBeGreaterThan(3)
  })

  test("uses the last side window as compact absorber while Main is focused", () => {
    const layout = computeLayout({ width: 120, height: 24 }, { focus: "main", currentSideWindow: "branches" })
    expect(heightOf(layout.windows.branches)).toBeGreaterThan(3)
    expect(heightOf(layout.windows.commits)).toBe(3)
    expect(heightOf(layout.windows.stash)).toBe(3)
  })

  test("lower-right log height does not reduce the left side-section height", () => {
    const hidden = computeLayout({ width: 120, height: 40 }, { logVisible: false, currentSideWindow: "files" })
    const shown = computeLayout({ width: 120, height: 40 }, { logVisible: true, logHeight: 12, currentSideWindow: "files" })
    for (const pane of SIDE_WINDOWS) expect(heightOf(shown.windows[pane])).toBe(heightOf(hidden.windows[pane]))
  })

  test("normal vs compact threshold at 28 available rows", () => {
    // terminal 29 => body 28 (normal), terminal 28 => body 27 (compact)
    const normal = computeLayout({ width: 120, height: 29 }, { focus: "commits", currentSideWindow: "commits", hintsVisible: true })
    expect(heightOf(normal.windows.stash)).toBe(3) // stash folded even in normal (not current)
    expect(heightOf(normal.windows.branches)).toBeGreaterThan(3)
    const compact = computeLayout({ width: 120, height: 28 }, { focus: "commits", currentSideWindow: "commits", hintsVisible: true })
    expect(heightOf(compact.windows.branches)).toBe(3)
    expect(heightOf(compact.windows.commits)).toBeGreaterThan(3)
  })

  test("compact squash threshold at 21 available rows", () => {
    // terminal 22 => body 21 (squashed 3), terminal 21 => body 20 (squashed 1)
    const tallSquashed = computeLayout({ width: 120, height: 22 }, { focus: "main", currentSideWindow: "files", hintsVisible: true })
    expect(heightOf(tallSquashed.windows.branches)).toBe(3)
    expect(heightOf(tallSquashed.windows.status)).toBe(3)
    const tiny = computeLayout({ width: 120, height: 21 }, { focus: "main", currentSideWindow: "files", hintsVisible: true })
    expect(heightOf(tiny.windows.branches)).toBe(1)
    expect(heightOf(tiny.windows.status)).toBe(1)
    expect(heightOf(tiny.windows.files)).toBeGreaterThan(1)
  })

  test("partitions the side height exactly across the five panes", () => {
    for (const height of [40, 33, 26, 19, 12]) {
      const layout = computeLayout({ width: 120, height }, { focus: "files", currentSideWindow: "files", hintsVisible: true })
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
    // The four non-focused side panes are absent from the map entirely,
    // rather than present at zero extent (Finding 2).
    expect(layout.windows.files).toBeUndefined()
    expect(layout.windows.branches).toBeUndefined()
    expect(layout.windows.stash).toBeUndefined()
    expect(layout.windows.status).toBeUndefined()
  })

  test("full mode with side focus collapses main", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", screenMode: "full" })
    expect(layout.windows.main).toBeUndefined()
    expect(layout.windows.vsplit).toBeUndefined()
    expect(widthOf(layout.windows.commits)).toBe(120)
  })

  test("full mode with side focus on a narrow terminal shows the side pane, not an empty layout", () => {
    // Regression for Finding 1: width 50 is narrower than MIN_LEFT_WIDTH +
    // SPLITTER_SIZE + MIN_MAIN_WIDTH (59), and the side pane is enlarged.
    const layout = computeLayout({ width: 50, height: 40 }, { focus: "commits", screenMode: "full" })
    expect(Object.keys(layout.windows).length).toBeGreaterThan(0)
    expect(widthOf(layout.windows.commits)).toBe(50)
    expect(layout.windows.main).toBeUndefined()
  })

  test("half mode with side focus on a narrow terminal shows the side pane instead of main", () => {
    const layout = computeLayout({ width: 50, height: 40 }, { focus: "commits", screenMode: "half" })
    expect(widthOf(layout.windows.commits)).toBe(50)
    expect(layout.windows.main).toBeUndefined()
  })

  test("normal mode on a narrow terminal still hides the side region and gives main full width", () => {
    const layout = computeLayout({ width: 50, height: 40 }, { focus: "commits", screenMode: "normal" })
    expect(layout.windows.commits).toBeUndefined()
    expect(layout.windows.vsplit).toBeUndefined()
    expect(widthOf(layout.windows.main)).toBe(50)
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

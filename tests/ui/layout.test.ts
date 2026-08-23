import { describe, expect, test } from "bun:test"
import { computeLayout } from "../../src/ui/layout"

describe("computeLayout", () => {
  test("uses requested left width and command log height", () => {
    const layout = computeLayout(
      { width: 120, height: 40 },
      { leftWidth: 30, logHeight: 8, logVisible: true },
    )

    expect(layout).toMatchObject({ leftWidth: 30, mainWidth: 89, logHeight: 8 })
    expect(layout.verticalSplitterWidth).toBe(1)
    expect(layout.horizontalSplitterHeight).toBe(1)
  })

  test("clamps both splitters to preferred minima", () => {
    const layout = computeLayout(
      { width: 80, height: 12 },
      { leftWidth: 999, logHeight: 999, logVisible: true },
    )

    expect(layout.leftWidth).toBe(39)
    expect(layout.mainWidth).toBe(40)
    expect(layout.logHeight).toBe(3)
    expect(layout.mainHeight).toBe(8)
  })

  test("omits command log and horizontal splitter when hidden", () => {
    const layout = computeLayout(
      { width: 120, height: 40 },
      { leftWidth: 30, logHeight: 8, logVisible: false },
    )

    expect(layout.logVisible).toBe(false)
    expect(layout.logHeight).toBe(0)
    expect(layout.horizontalSplitterHeight).toBe(0)
    expect(layout.mainHeight).toBe(40)
  })

  test("does not produce negative dimensions at tiny terminal sizes", () => {
    for (const width of [1, 2, 10, 20]) {
      for (const height of [1, 2, 5, 10]) {
        const layout = computeLayout(
          { width, height },
          { leftWidth: 30, logHeight: 8, logVisible: true },
        )
        for (const value of Object.values(layout)) {
          if (typeof value === "number") expect(value).toBeGreaterThanOrEqual(0)
        }
        expect(layout.mainWidth).toBeGreaterThanOrEqual(1)
        expect(layout.mainHeight).toBeGreaterThanOrEqual(1)
        expect(layout.leftWidth + layout.verticalSplitterWidth + layout.mainWidth).toBe(width)
        expect(layout.mainHeight + layout.horizontalSplitterHeight + layout.logHeight).toBe(height)
      }
    }
  })
})

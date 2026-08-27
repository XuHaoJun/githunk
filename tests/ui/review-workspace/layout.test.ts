import { describe, expect, test } from "bun:test"
import { computeReviewLayout } from "../../../src/ui/review-workspace/layout"

describe("computeReviewLayout — auto split threshold", () => {
  test("auto chooses split when remaining diff viewport fits 32*2 + gutters", () => {
    // sidebar 28 + 1 border =29, remaining 91, threshold 80 => split
    const layout = computeReviewLayout(120, 30, "auto", true)
    expect(layout.effectiveMode).toBe("split")
    expect(layout.sidebar).not.toBeNull()
  })

  test("auto chooses stack when remaining diff viewport insufficient", () => {
    // width 60 with sidebar 28 => remaining 31 (<80) => stack, but sidebar still visible per spec? Effective stack
    const layout = computeReviewLayout(60, 30, "auto", true)
    expect(layout.effectiveMode).toBe("stack")
  })

  test("collapsed sidebar calculation uses remaining viewport, not total width", () => {
    const withSidebar = computeReviewLayout(70, 30, "auto", true)
    const withoutSidebar = computeReviewLayout(70, 30, "auto", false)
    // with sidebar remaining 41 (<80) => stack; without 70 (<80) still stack in this case
    // Use larger width where sidebar makes difference: 95 total
    const with95 = computeReviewLayout(95, 30, "auto", true) // remaining 66 => stack
    const without95 = computeReviewLayout(95, 30, "auto", false) // remaining 95 => split
    expect(with95.effectiveMode).toBe("stack")
    expect(without95.effectiveMode).toBe("split")
  })

  test("auto with collapsed sidebar and sufficient width still splits", () => {
    const layout = computeReviewLayout(90, 30, "auto", false)
    expect(layout.effectiveMode).toBe("split")
  })
})

describe("computeReviewLayout — forced modes", () => {
  test("forced split keeps split even on narrow terminal", () => {
    const layout = computeReviewLayout(50, 30, "split", true)
    expect(layout.effectiveMode).toBe("split")
    // sidebar hidden on narrow even when forced split
    expect(layout.sidebar).toBeNull()
  })

  test("forced stack keeps stack even on wide terminal", () => {
    const layout = computeReviewLayout(200, 30, "stack", true)
    expect(layout.effectiveMode).toBe("stack")
    expect(layout.sidebar).not.toBeNull()
  })
})

describe("computeReviewLayout — collapsed sidebar", () => {
  test("explicit sidebarVisible false hides sidebar and expands stream", () => {
    const withSidebar = computeReviewLayout(120, 30, "auto", true)
    const without = computeReviewLayout(120, 30, "auto", false)
    expect(withSidebar.sidebar).not.toBeNull()
    expect(without.sidebar).toBeNull()
    expect(without.stream.width).toBeGreaterThan(withSidebar.stream.width)
  })
})

describe("computeReviewLayout — narrow/short fallback", () => {
  test("very narrow terminal hides sidebar and forces stack", () => {
    const layout = computeReviewLayout(30, 30, "auto", true)
    expect(layout.sidebar).toBeNull()
    expect(layout.effectiveMode).toBe("stack")
    expect(layout.stream.width).toBeGreaterThan(0)
    expect(layout.header.height).toBeGreaterThan(0)
  })

  test("very short terminal hides sidebar and forces stack", () => {
    const layout = computeReviewLayout(120, 8, "auto", true)
    expect(layout.sidebar).toBeNull()
    expect(layout.effectiveMode).toBe("stack")
  })

  test("layout rectangles are within terminal bounds", () => {
    const cases: Array<[number, number]> = [
      [80, 24],
      [120, 30],
      [40, 12],
      [200, 40],
    ]
    for (const [w, h] of cases) {
      const l = computeReviewLayout(w, h, "auto", true)
      expect(l.header.width).toBe(w)
      expect(l.footer.width).toBe(w)
      expect(l.stream.width).toBeGreaterThan(0)
      expect(l.header.x).toBe(0)
      expect(l.header.y).toBe(0)
      expect(l.footer.y + l.footer.height).toBe(h)
    }
  })
})

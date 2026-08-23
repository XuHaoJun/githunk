import { describe, expect, test } from "bun:test"
import { computePaneLayout, resizeLeftPane } from "../src/layout"

describe("pane geometry", () => {
  test("keeps useful minimum widths", () => {
    expect(computePaneLayout(120, 30)).toEqual({
      terminalWidth: 120,
      leftWidth: 30,
      splitterX: 30,
      rightWidth: 89,
    })
  })

  test("clamps the left pane when dragged too far left", () => {
    const initial = computePaneLayout(120, 30)
    expect(resizeLeftPane(initial, 2).leftWidth).toBe(18)
  })

  test("protects at least 40 columns for the patch pane", () => {
    const initial = computePaneLayout(120, 30)
    const resized = resizeLeftPane(initial, 110)
    expect(resized.rightWidth).toBeGreaterThanOrEqual(40)
  })
})

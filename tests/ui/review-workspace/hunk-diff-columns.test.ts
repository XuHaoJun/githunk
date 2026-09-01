import { describe, expect, test } from "bun:test"
import {
  expandHunkDiffTabs,
  measureHunkRenderedWidth,
  resolveHunkSplitPaneWidths,
  resolveHunkSplitCellGeometry,
  resolveHunkStackCellGeometry,
} from "../../../src/ui/review-workspace/hunk-code-columns"

describe("Hunk diff column geometry", () => {
  test("reserves a separator and splits the available terminal width", () => {
    expect(resolveHunkSplitPaneWidths(120)).toEqual({ leftWidth: 60, rightWidth: 60 })
    expect(resolveHunkSplitCellGeometry(60, 3, true)).toEqual({ gutterWidth: 6, contentWidth: 53 })
    expect(resolveHunkStackCellGeometry(120, 3, true)).toEqual({ gutterWidth: 11, contentWidth: 108 })
  })

  test("measures tabs and wide characters in terminal cells", () => {
    expect(expandHunkDiffTabs("a\t界", 4)).toBe("a   界")
    expect(measureHunkRenderedWidth("a\t界", 4)).toBe(6)
  })
})

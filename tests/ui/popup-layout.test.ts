import { describe, expect, test } from "bun:test"
import { popupPanelGeometry, popupPanelWidth } from "../../src/ui/popup-layout"

/**
 * lazygit v0.66 gives a popup the width it asks for while a three-column margin fits beside it,
 * gives the margin up before going under 80 columns, and leaves a column either side at the end
 * (confirmation_helper.go:129-151, commit d0fa50d4e). It centres the panel as
 * `(width - panelWidth) / 2` so a panel of odd width stays centred (commit 7253a45c2).
 */
describe("popup panel sizing", () => {
  test("gives a menu its full width once the window has room for it", () => {
    expect(popupPanelWidth(200, 90)).toBe(90)
    expect(popupPanelWidth(140, 90)).toBe(90)
    expect(popupPanelWidth(120, 90)).toBe(90)
  })

  test("keeps a three-column margin until that would go under 80 columns", () => {
    expect(popupPanelWidth(92, 90)).toBe(86)
    expect(popupPanelWidth(84, 90)).toBe(80)
    expect(popupPanelWidth(84, 80)).toBe(80)
  })

  test("leaves a column either side in a narrow window", () => {
    expect(popupPanelWidth(50, 80)).toBe(48)
  })

  test("centres a panel of odd width on the window", () => {
    expect(popupPanelGeometry(100, 24, 77, 3).left).toBe(10)
    expect(popupPanelGeometry(101, 24, 78, 3).left).toBe(10)
  })
})

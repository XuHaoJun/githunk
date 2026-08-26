import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  ANSI_GREEN,
  DEFAULT_FOREGROUND,
  SELECTED_LINE_BG,
  brightenAnsiForeground,
} from "../../src/ui/theme"

describe("lazygit color semantics", () => {
  test("keeps named colors as indexed terminal colors", () => {
    expect(ANSI_GREEN.intent).toBe("indexed")
    expect(ANSI_GREEN.slot).toBe(2)
    expect(SELECTED_LINE_BG.intent).toBe("indexed")
    expect(SELECTED_LINE_BG.slot).toBe(4)
  })

  test("keeps default foreground as terminal default", () => {
    expect(DEFAULT_FOREGROUND.intent).toBe("default")
  })

  test("brightens only base indexed colors", () => {
    const brightGreen = brightenAnsiForeground(ANSI_GREEN)
    expect(brightGreen.intent).toBe("indexed")
    expect(brightGreen.slot).toBe(10)

    const rgb = RGBA.fromInts(26, 43, 60)
    expect(brightenAnsiForeground(rgb)).toBe(rgb)
  })
})

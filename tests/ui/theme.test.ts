import { describe, expect, test } from "bun:test"
import { ANSI_GREEN, DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, SELECTED_LINE_BG, configureTerminalPalette, indexedColor } from "../../src/ui/theme"

describe("lazygit color semantics", () => {
  test("keeps named colors as indexed terminal colors", () => {
    expect(ANSI_GREEN.intent).toBe("indexed")
    expect(ANSI_GREEN.slot).toBe(2)
    expect(SELECTED_LINE_BG.intent).toBe("indexed")
    expect(SELECTED_LINE_BG.slot).toBe(4)
  })
  test("uses the Ghostty fallback palette when no query is available", () => {
    configureTerminalPalette({})
    expect(ANSI_GREEN.toInts()).toEqual([0xb5, 0xbd, 0x68, 255])
    expect(SELECTED_LINE_BG.toInts()).toEqual([0x81, 0xa2, 0xbe, 255])
    expect(DEFAULT_FOREGROUND.toInts()).toEqual([255, 255, 255, 255])
    expect(DEFAULT_BACKGROUND.toInts()).toEqual([0x28, 0x2c, 0x34, 255])
  })

  test("keeps default foreground as terminal default", () => {
    expect(DEFAULT_FOREGROUND.intent).toBe("default")
  })

  test("uses the terminal palette as the indexed fallback", () => {
    configureTerminalPalette({
      palette: [null, "#112233", "#445566", null, "#778899"],
      defaultForeground: "#aabbcc",
      defaultBackground: "#010203"
    })

    expect(ANSI_GREEN.intent).toBe("indexed")
    expect(ANSI_GREEN.slot).toBe(2)
    expect(ANSI_GREEN.toInts()).toEqual([0x44, 0x55, 0x66, 255])
    expect(indexedColor(1).toInts()).toEqual([0x11, 0x22, 0x33, 255])
    expect(SELECTED_LINE_BG.toInts()).toEqual([0x77, 0x88, 0x99, 255])
    expect(DEFAULT_FOREGROUND.toInts()).toEqual([0xaa, 0xbb, 0xcc, 255])
    expect(DEFAULT_BACKGROUND.toInts()).toEqual([1, 2, 3, 255])

    configureTerminalPalette({})
  })
})

import { describe, expect, test } from "bun:test"
import { splitterGlyphs } from "../../src/ui/splitter"

describe("splitterGlyphs", () => {
  test("draws a vertical rule, one glyph per row", () => {
    expect(splitterGlyphs("vertical", 1, 4, false)).toBe("│\n│\n│\n│")
  })

  test("draws a horizontal rule across the width", () => {
    expect(splitterGlyphs("horizontal", 5, 1, false)).toBe("─────")
  })

  test("marks the midpoint with a grab glyph while hovered", () => {
    expect(splitterGlyphs("vertical", 1, 5, true)).toBe("│\n│\n⇔\n│\n│")
    expect(splitterGlyphs("horizontal", 5, 1, true)).toBe("──⇕──")
  })

  test("degrades to a single glyph at minimum extents", () => {
    expect(splitterGlyphs("vertical", 1, 1, false)).toBe("│")
    expect(splitterGlyphs("vertical", 1, 1, true)).toBe("⇔")
  })

  test("renders nothing for a zero extent", () => {
    expect(splitterGlyphs("vertical", 1, 0, false)).toBe("")
    expect(splitterGlyphs("horizontal", 0, 1, false)).toBe("")
  })
})

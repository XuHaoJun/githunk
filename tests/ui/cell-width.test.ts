import { describe, expect, test } from "bun:test"
import { cellWidth, isWide } from "../../src/ui/cell-width"

/**
 * `cellWidth` is a port of lazygit's `utils.StringWidth`
 * (`learn-projects/lazygit/pkg/utils/formatting.go:25-35`): an ASCII fast path over the bytes, and
 * otherwise a per-grapheme width table standing in for `uniseg.StringWidth`, which githunk cannot
 * ship (no new runtime dependencies).
 *
 * Two callers depend on it — the command log's tip-label boundary and the commits pane's author
 * column — and neither can see the difference between the two branches, so these tests check them
 * against each other directly.
 */
describe("cellWidth", () => {
  test("counts an empty string as no cells", () => {
    expect(cellWidth("")).toBe(0)
  })

  test("counts every printable ASCII character as one cell", () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const character = String.fromCharCode(code)
      expect(cellWidth(character), `U+${code.toString(16)}`).toBe(1)
    }
    expect(cellWidth("hello world")).toBe(11)
  })

  test("the ASCII fast path agrees with the per-code-point path", () => {
    // The fast path returns `value.length` without looking at a single code point. Prefixing a
    // one-cell non-ASCII character (U+00E9, é) sends the *whole* string down the per-code-point loop
    // instead, so the two branches must differ by exactly that character's own cell.
    expect(cellWidth("\u00e9")).toBe(1)
    for (const ascii of ["", "a", "hello world", "  git add -- b.txt", "Random tip: ", "@@ -1,1 +1,1 @@"]) {
      expect(cellWidth(`\u00e9${ascii}`), JSON.stringify(ascii)).toBe(cellWidth(ascii) + 1)
    }
  })

  test("counts East Asian wide characters as two cells", () => {
    expect(cellWidth("中")).toBe(2)
    expect(cellWidth("中文")).toBe(4)
    expect(cellWidth("a中b")).toBe(4)
    expect(cellWidth("한")).toBe(2) // Hangul syllables
    expect(cellWidth("\u{20000}")).toBe(2) // CJK unified ideographs extension B
    expect(cellWidth("\uff21")).toBe(2) // fullwidth Latin capital A
  })

  test("counts emoji as two cells, which is what OpenTUI's buffer gives them", () => {
    // The ranges these pin were the fix for a mis-measured tip label: OpenTUI 0.5.6 renders U+1F3B2
    // in two columns, so a label ending in one measured a cell short and handed its last column to
    // the run after it (see ./command-log-text.test.ts's wide-label test).
    expect(cellWidth("🎲")).toBe(2)
    expect(cellWidth("a🎲b")).toBe(4)
    for (const codePoint of [0x1f300, 0x1f9ff, 0x1fa70, 0x1faff]) {
      expect(cellWidth(String.fromCodePoint(codePoint)), `U+${codePoint.toString(16)}`).toBe(2)
    }
    // The table's edges, stated rather than assumed: the ranges start at U+1F300, so the older
    // symbol blocks below it (mahjong tiles, playing cards, and the U+2600 miscellaneous symbols
    // inside the CJK-through-Yi range's neighbours) are not covered. Nothing githunk paints uses
    // them, and the error is one column on one boundary.
    expect(cellWidth("\u{1f000}")).toBe(1)
    expect(cellWidth("\u{1f2ff}")).toBe(1)
  })

  test("gives a combining mark a cell of its own, as the approximation's bound says", () => {
    // No grapheme clustering — neither here nor in OpenTUI 0.5.6 — so a decomposed é is two cells
    // where its precomposed form is one. That is the documented error: one column on a boundary
    // between two styled runs, never a mis-coloured line.
    expect(cellWidth("e\u0301")).toBe(2) // decomposed: e + COMBINING ACUTE ACCENT
    expect(cellWidth("\u00e9")).toBe(1) // precomposed é
    // A regional-indicator pair (a flag) is two code points below the table's emoji ranges, so it
    // measures 1 + 1 where a clustering terminal draws one two-cell glyph — the same one-column
    // error, in the other direction.
    expect(cellWidth("\u{1f1e6}\u{1f1fa}")).toBe(2)
  })
})

/**
 * `isWide` answers for one grapheme, and only about its *leading* code point — which is what
 * lazygit's `getInitials` asks of `uniseg.FirstGraphemeClusterInString`
 * (`pkg/gui/presentation/authors/authors.go:117-120`).
 */
describe("isWide", () => {
  test("looks only at the leading code point", () => {
    expect(isWide("中a")).toBe(true)
    expect(isWide("a中")).toBe(false)
    expect(isWide("🎲 Bob")).toBe(true)
  })

  test("says no for an empty string", () => {
    expect(isWide("")).toBe(false)
  })
})

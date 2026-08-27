import { describe, expect, test } from "bun:test"
import { AUTHOR_COLUMN_WIDTH, authorColor, authorInitials } from "../../src/ui/author-style"
import { cellWidth } from "../../src/ui/cell-width"

/**
 * Port of lazygit's `getInitials` (`learn-projects/lazygit/pkg/gui/presentation/authors/authors.go`,
 * the function at :112-128). The commits pane pads the result to `AUTHOR_COLUMN_WIDTH`
 * (`commits-pane.ts:73`, lazygit's `Gui.CommitAuthorShortLength` default of 2), so what these tests
 * really guard is that the initials fit the column they are padded into.
 */
describe("authorInitials", () => {
  test("takes the initials of the first two words", () => {
    expect(authorInitials("Ada Lovelace")).toBe("AL")
    expect(authorInitials("Jean-Luc Picard")).toBe("JP")
    expect(authorInitials("  Ada   Lovelace  ")).toBe("AL")
  })

  test("takes the first two characters of a single-word name", () => {
    expect(authorInitials("Ada")).toBe("Ad")
  })

  test("yields nothing for an empty name", () => {
    expect(authorInitials("")).toBe("")
  })

  test("lets a wide leading grapheme fill the column on its own", () => {
    // lazygit's `width > 1` branch (authors.go:117-120): a grapheme already two cells wide *is* the
    // column, so no second character is taken.
    expect(authorInitials("中村 太郎")).toBe("中")
    expect(cellWidth(authorInitials("中村 太郎"))).toBe(AUTHOR_COLUMN_WIDTH)
  })

  test("treats a leading emoji as wide, so it fills the column alone", () => {
    // Regression: before `cell-width.ts` gained the emoji ranges, `isWide("🎲")` was false, so this
    // name took the "first two words" branch and produced "🎲B" — three display cells in a
    // two-cell column, which pushes every column after it one cell right for that one row.
    expect(authorInitials("🎲 Bob")).toBe("🎲")
    expect(cellWidth(authorInitials("🎲 Bob"))).toBe(AUTHOR_COLUMN_WIDTH)
    expect(cellWidth("🎲B")).toBeGreaterThan(AUTHOR_COLUMN_WIDTH)
  })

  test("keeps every plausible author inside the column it is padded into", () => {
    for (const name of ["Ada Lovelace", "Ada", "中村 太郎", "🎲 Bob", "élodie Martin", "ADA"]) {
      const initials = authorInitials(name)
      expect(cellWidth(initials), JSON.stringify(name)).toBeLessThanOrEqual(AUTHOR_COLUMN_WIDTH)
    }
  })
})

describe("authorColor", () => {
  test("gives one author the same colour every time, and different authors different ones", () => {
    // The commits pane derives both the author cell and the graph pipe colour from this, so it has
    // to be a pure function of the name — lazygit's `md5(name)` → HSL → RGB derivation.
    expect(authorColor("Ada Lovelace")).toBe(authorColor("Ada Lovelace"))
    expect(authorColor("Ada Lovelace")).toMatch(/^#[0-9a-f]{6}$/)
    expect(authorColor("Ada Lovelace")).not.toBe(authorColor("Grace Hopper"))
  })
})

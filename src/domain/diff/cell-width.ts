/**
 * Display-cell width — the unit a terminal grid, and OpenTUI's text buffer, address columns in.
 *
 * lazygit measures the same way: `utils.StringWidth` (pkg/utils/formatting.go:25-35) takes an ASCII
 * fast path and otherwise defers to `uniseg.StringWidth`, and `getInitials`
 * (pkg/gui/presentation/authors/authors.go:117-120) treats a leading grapheme wider than one cell as
 * filling the author column on its own. githunk cannot ship uniseg's table (no new runtime
 * dependencies), so `WIDE_RANGES` approximates the Unicode East Asian Width `W`/`F` blocks.
 *
 * The approximation is deliberate and its error is bounded: the two callers use it for a *boundary*
 * between adjacent styled runs (a column in an already-installed line), so a grapheme the table
 * misjudges — a combining mark, a variation selector, a ZWJ sequence, a regional-indicator pair,
 * none of which OpenTUI 0.5.6 clusters either — shifts that boundary by a cell. It never changes
 * which line is coloured, and it cannot fail.
 */

/**
 * East Asian Wide/Fullwidth blocks, coarsened to whole ranges. The emoji ranges matter: OpenTUI's
 * buffer gives U+1F3B2 two columns, so a label ending in one would otherwise be measured a cell
 * short and hand its last column to the run after it.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0xa4cf], // CJK radicals through Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f9ff], // emoji: pictographs, emoticons, transport, supplemental symbols
  [0x1fa70, 0x1faff], // emoji: symbols and pictographs extended-A
  [0x20000, 0x3fffd], // CJK unified ideographs extension B and beyond
]

/** Whether `grapheme`'s leading code point occupies two columns rather than one. */
export function isWide(grapheme: string): boolean {
  const code = grapheme.codePointAt(0)
  if (code === undefined) return false
  for (const [low, high] of WIDE_RANGES) {
    if (code >= low && code <= high) return true
  }
  return false
}

/** `value`'s width in display cells. */
export function cellWidth(value: string): number {
  // lazygit's own fast path: an all-ASCII string is one cell per character (formatting.go:26-32).
  let ascii = true
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return value.length
  let width = 0
  for (const codePoint of value) width += isWide(codePoint) ? 2 : 1
  return width
}

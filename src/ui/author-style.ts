import { createHash } from "node:crypto"

/**
 * Port of lazygit `pkg/gui/presentation/authors/authors.go`.
 *
 * Lazygit derives both the author column and the commit-graph pipe colour from
 * the author name, so the two always agree. We mirror the same md5 → HSL → RGB
 * derivation so a given author gets the same hue lazygit would give them.
 */

const initialsCache = new Map<string, string>()
const colorCache = new Map<string, string>()

/** Sum of bytes folded through `% max`, matching lazygit's `randInt`. */
function randInt(bytes: Uint8Array, max: number): number {
  let sum = 0
  for (const byte of bytes) sum = (sum + byte) % max
  return sum
}

function randFloat(bytes: Uint8Array): number {
  return randInt(bytes, 100) / 100
}

function hueToChannel(t1: number, t2: number, hue: number): number {
  let h = hue
  if (h < 0) h += 1
  if (h > 1) h -= 1
  if (6 * h < 1) return t2 + (t1 - t2) * 6 * h
  if (2 * h < 1) return t1
  if (3 * h < 2) return t2 + (t1 - t2) * (2 / 3 - h) * 6
  return t2
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.floor(l * 255)
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`
  }
  const t1 = l < 0.5 ? l * (1 + s) : l + s - l * s
  const t2 = 2 * l - t1
  const hNorm = h / 360
  const channels = [hueToChannel(t1, t2, hNorm + 1 / 3), hueToChannel(t1, t2, hNorm), hueToChannel(t1, t2, hNorm - 1 / 3)]
  return `#${channels.map((c) => Math.floor(c * 255).toString(16).padStart(2, "0")).join("")}`
}

/** Stable per-author colour: `md5(name)` seeds hue/saturation/lightness, as lazygit's `trueColorStyle` does. */
export function authorColor(authorName: string): string {
  const cached = colorCache.get(authorName)
  if (cached !== undefined) return cached
  const hash = new Uint8Array(createHash("md5").update(authorName).digest())
  const color = hslToHex(
    randFloat(hash.slice(0, 4)) * 360,
    0.6 + 0.4 * randFloat(hash.slice(4, 8)),
    0.4 + 0.2 * randFloat(hash.slice(8, 12)),
  )
  colorCache.set(authorName, color)
  return color
}

/**
 * Lazygit's `getInitials`: a wide leading grapheme stands alone, a single-word
 * name yields its first two characters, otherwise the initials of the first two
 * words. Always renders in `AUTHOR_COLUMN_WIDTH` cells once padded.
 */
export function authorInitials(authorName: string): string {
  const cached = initialsCache.get(authorName)
  if (cached !== undefined) return cached
  const initials = computeInitials(authorName)
  initialsCache.set(authorName, initials)
  return initials
}

function computeInitials(authorName: string): string {
  if (authorName === "") return ""
  const graphemes = [...authorName]
  const first = graphemes[0]!
  // A wide leading character (CJK and friends) already fills the column on its own.
  if (isWide(first)) return first
  const parts = authorName.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 0) return ""
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join("")
  return `${[...parts[0]!][0] ?? ""}${[...parts[1]!][0] ?? ""}`
}

function isWide(grapheme: string): boolean {
  const code = grapheme.codePointAt(0)
  if (code === undefined) return false
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Lazygit's `Gui.CommitAuthorShortLength` default. */
export const AUTHOR_COLUMN_WIDTH = 2

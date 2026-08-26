import { RGBA } from "@opentui/core"
import { indexedColor } from "./theme"


/**
 * Turns a git command's own coloured output into plain text plus row-local style spans.
 *
 * lazygit hands the bytes of `git log --graph --color=always …` straight to gocui, which
 * understands SGR sequences (pkg/gocui/escape.go). OpenTUI does not: its text buffer holds
 * unstyled text and a separate list of per-row column highlights. So the sequences are
 * interpreted here instead, and the result feeds ./panes/ansi-text — which paints only the rows
 * a viewport shows, the same way ./panes/diff-text paints a patch.
 *
 * Only the foreground half of SGR is kept. That is all git emits for a log graph (graph columns,
 * `commit <hash>`, decorations and the `diff --git` family are foreground-and-attribute only),
 * and a background would have to compete with the list's own selection highlight.
 */

export type AnsiSpan = {
  /** 0-based line of the parsed text. */
  readonly row: number
  /**
   * Column bounds within the row, `[start, end)`. Counted in code points, which is what the graph
   * glyphs, hashes and refs git colours are made of; a full-width rune inside a *coloured* run
   * (only possible in a branch name) would shift the run's end by one cell.
   */
  readonly start: number
  readonly end: number
  /** Foreground colour with its terminal RGB/index/default intent preserved. */
  readonly fg?: RGBA
  readonly bold?: boolean
  readonly dim?: boolean
}

export type AnsiText = {
  readonly text: string
  readonly spans: readonly AnsiSpan[]
}

type AnsiStyle = {
  fg: RGBA | undefined
  bold: boolean
  dim: boolean
}


const DEFAULT_STYLE: AnsiStyle = { fg: undefined, bold: false, dim: false }

function styled(style: AnsiStyle): boolean {
  return style.fg !== undefined || style.bold || style.dim
}
function sameColor(a: RGBA | undefined, b: RGBA | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.intent !== b.intent) return false
  if (a.intent === "indexed" || a.intent === "default") return a.slot === b.slot
  const [ar, ag, ab, aa] = a.toInts()
  const [br, bg, bb, ba] = b.toInts()
  return ar === br && ag === bg && ab === bb && aa === ba
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return sameColor(a.fg, b.fg) && a.bold === b.bold && a.dim === b.dim
}

/** xterm's 256-colour index space, preserved as indexed intent for the terminal to resolve. */
function color256(index: number): RGBA | undefined {
  if (index < 0 || index > 255) return undefined
  return indexedColor(index)
}


/**
 * Folds one SGR sequence's parameters into `style`. Parameters this renderer has no place for
 * (backgrounds, italics, underlines, blink) are consumed and dropped rather than ending the run,
 * so a `\e[4m` in the middle of a coloured decoration does not split its span.
 */
function applySgr(style: AnsiStyle, params: readonly number[]): AnsiStyle {
  let next = { ...style }
  for (let index = 0; index < params.length; index++) {
    const param = params[index]!
    if (param === 0) {
      next = { ...DEFAULT_STYLE }
    } else if (param === 1) {
      next.bold = true
    } else if (param === 2) {
      next.dim = true
    } else if (param === 22) {
      next.bold = false
      next.dim = false
    } else if (param >= 30 && param <= 37) {
      next.fg = indexedColor(param - 30)
    } else if (param >= 90 && param <= 97) {
      next.fg = indexedColor(param - 90 + 8)
    } else if (param === 39) {
      next.fg = undefined
    } else if (param === 38) {
      const mode = params[index + 1]
      if (mode === 5) {
        next.fg = color256(params[index + 2] ?? -1)
        index += 2
      } else if (mode === 2) {
        const [red, green, blue] = [params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0]
        next.fg = RGBA.fromInts(red & 0xff, green & 0xff, blue & 0xff)
        index += 4
      }
    }
  }
  return next
}

function parseParams(body: string): readonly number[] {
  if (body.length === 0) return [0]
  return body.split(";").map((part) => (part.length === 0 ? 0 : Number.parseInt(part, 10))).map((value) => (Number.isFinite(value) ? value : 0))
}

/**
 * Length of the escape sequence starting at `input[index]` (which must be ESC), or 1 when it is a
 * lone ESC at the end of the input. CSI runs to its final byte in `@`-`~`; OSC runs to BEL or ST;
 * anything else is ESC plus one byte, which covers the charset selectors (`ESC ( B`) git's pager
 * setup can leave behind.
 */
function escapeLength(input: string, index: number): number {
  const introducer = input[index + 1]
  if (introducer === "[") {
    let cursor = index + 2
    while (cursor < input.length) {
      const code = input.charCodeAt(cursor)
      if (code >= 0x40 && code <= 0x7e) return cursor - index + 1
      cursor++
    }
    return input.length - index
  }
  if (introducer === "]") {
    let cursor = index + 2
    while (cursor < input.length) {
      if (input[cursor] === "\u0007") return cursor - index + 1
      if (input[cursor] === "\u001b" && input[cursor + 1] === "\\") return cursor - index + 2
      cursor++
    }
    return input.length - index
  }
  if (introducer === undefined) return 1
  // Charset selectors are three bytes: ESC, the designator, then the charset's final byte.
  return "()*+%".includes(introducer) ? 3 : 2
}

export function parseAnsi(input: string): AnsiText {
  const out: string[] = []
  const spans: AnsiSpan[] = []
  let style: AnsiStyle = { ...DEFAULT_STYLE }
  let row = 0
  let column = 0
  let runStart = 0
  let runStyle: AnsiStyle = { ...DEFAULT_STYLE }

  const closeRun = (): void => {
    if (column > runStart && styled(runStyle)) {
      spans.push({
        row,
        start: runStart,
        end: column,
        ...(runStyle.fg === undefined ? {} : { fg: runStyle.fg }),
        ...(runStyle.bold ? { bold: true } : {}),
        ...(runStyle.dim ? { dim: true } : {}),
      })
    }
    runStart = column
  }

  for (let index = 0; index < input.length; ) {
    const char = input[index]!
    if (char === "\u001b") {
      const length = escapeLength(input, index)
      if (input[index + 1] === "[" && input[index + length - 1] === "m") {
        const next = applySgr(style, parseParams(input.slice(index + 2, index + length - 1)))
        if (!sameStyle(next, runStyle)) {
          closeRun()
          runStyle = next
        }
        style = next
      }
      index += length
      continue
    }
    if (char === "\n") {
      closeRun()
      out.push(char)
      row++
      column = 0
      runStart = 0
      index += 1
      continue
    }
    // A surrogate pair is one code point, so it advances the column once.
    const codePoint = input.codePointAt(index)!
    const size = codePoint > 0xffff ? 2 : 1
    out.push(input.slice(index, index + size))
    column += 1
    index += size
  }
  closeRun()
  return { text: out.join(""), spans }
}

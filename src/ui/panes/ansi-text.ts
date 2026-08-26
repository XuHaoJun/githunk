import { StyledText, bold as boldChunk, dim as dimChunk, fg as fgChunk, type TextChunk, type TextRenderable } from "@opentui/core"
import type { AnsiSpan } from "../ansi"
import { paneTextBuffer, type PaneTextBuffer } from "./pane-text"
import { createViewportHighlights, type ViewportHighlights } from "./viewport-highlights"

/**
 * Pushes a git command's own coloured output into a pane's text viewport, colouring only the rows
 * the viewport shows.
 *
 * The third pane on ./viewport-highlights, and the same bargain the other two make: the text goes in
 * unstyled and whole so OpenTUI keeps owning scrolling, wrapping and selection, while the colours —
 * here the spans ../ansi recovered from git's SGR sequences — are painted lazily around the
 * viewport. lazygit gets this for free because gocui parses SGR as it writes and never writes more
 * than it displays (pkg/gui/view_helpers.go:22 `linesToReadFromCmdTask`).
 *
 * What stays here is what is this content's own: interning a span's `(fg, bold, dim)` triple as a
 * style, grouping the spans by row, and the whole-document chunk fallback.
 */

export type AnsiTextContent = {
  /** Rendered ahead of the coloured body, unstyled (a tag's own metadata block); "" for none. */
  readonly preamble: string
  /** ../ansi's stripped text: exactly what the rows below hold. */
  readonly body: string
  /** ../ansi's spans, addressed in `body` rows — the preamble's height is added here. */
  readonly spans: readonly AnsiSpan[]
}

/** What one paint needs: the spans of each row, keyed by the row's index in the *pane*. */
type AnsiPaint = ReadonlyMap<number, readonly AnsiSpan[]>

type AnsiPainter = {
  readonly highlights: ViewportHighlights<AnsiPaint>
  /**
   * Style id per interned `(fg, bold, dim)` triple; ids are per text renderable, so the cache lives
   * as long as the painter — a release only stops the painting, it does not un-register a style.
   */
  readonly styleIds: Map<string, number>
}

const painters = new WeakMap<TextRenderable, AnsiPainter>()

function styleKey(span: AnsiSpan): string {
  const color = span.fg
  const colorKey = color === undefined ? "-" : `${color.intent}:${color.slot}:${color.toInts().join(",")}`
  return `${colorKey}|${span.bold === true ? "b" : "-"}${span.dim === true ? "d" : "-"}`
}

function styleIdFor(buffer: PaneTextBuffer, styleIds: Map<string, number>, span: AnsiSpan): number {
  const key = styleKey(span)
  const existing = styleIds.get(key)
  if (existing !== undefined) return existing
  const id = buffer.registerStyle(`githunk.ansi.${key}`, {
    ...(span.fg === undefined ? {} : { fg: span.fg }),
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.dim === true ? { dim: true } : {}),
  })
  styleIds.set(key, id)
  return id
}

function countRows(value: string): number {
  let rows = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) rows++
  return rows
}

/** The preamble always ends at a row boundary, so the body's first row is its line count. */
function joined(content: AnsiTextContent): { readonly text: string; readonly firstBodyRow: number } {
  const preamble = content.preamble.length === 0 || content.preamble.endsWith("\n") ? content.preamble : `${content.preamble}\n`
  return { text: `${preamble}${content.body}`, firstBodyRow: countRows(preamble) }
}

function groupByRow(spans: readonly AnsiSpan[], offset: number): AnsiPaint {
  const grouped = new Map<number, AnsiSpan[]>()
  for (const span of spans) {
    const row = span.row + offset
    const existing = grouped.get(row)
    if (existing === undefined) grouped.set(row, [span])
    else existing.push(span)
  }
  return grouped
}

/**
 * Whole-document chunk rendering: correct, and what this module exists to avoid. Reached only if a
 * future OpenTUI stops exposing the buffer, so the pane degrades in speed rather than colour.
 */
function paintAsChunks(text: TextRenderable, content: AnsiTextContent): void {
  const { text: full, firstBodyRow } = joined(content)
  const spansByRow = groupByRow(content.spans, firstBodyRow)
  const rows = full.split("\n")
  const chunks: TextChunk[] = []
  for (let row = 0; row < rows.length; row++) {
    const value = `${rows[row]!}${row === rows.length - 1 ? "" : "\n"}`
    const spans = spansByRow.get(row)
    if (spans === undefined || value.length === 0) {
      if (value.length > 0) chunks.push({ __isChunk: true, text: value } as TextChunk)
      continue
    }
    let cursor = 0
    const codePoints = Array.from(value)
    for (const span of spans) {
      if (span.start > cursor) chunks.push({ __isChunk: true, text: codePoints.slice(cursor, span.start).join("") } as TextChunk)
      const slice = codePoints.slice(Math.max(cursor, span.start), span.end).join("")
      if (slice.length > 0) {
        let chunk = span.fg === undefined ? ({ __isChunk: true, text: slice } as TextChunk) : fgChunk(span.fg)(slice)
        if (span.bold === true) chunk = boldChunk(chunk)
        if (span.dim === true) chunk = dimChunk(chunk)
        chunks.push(chunk)
      }
      cursor = Math.max(cursor, span.end)
    }
    if (cursor < codePoints.length) chunks.push({ __isChunk: true, text: codePoints.slice(cursor).join("") } as TextChunk)
  }
  text.content = new StyledText(chunks)
}

/**
 * Installs `content` as the pane's text. Re-installing the same text is a no-op beyond refreshing
 * the paint description, which is what makes re-focusing a panel free.
 */
export function installAnsiText(text: TextRenderable, content: AnsiTextContent): void {
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    paintAsChunks(text, content)
    return
  }
  const { text: full, firstBodyRow } = joined(content)
  const spansByRow = groupByRow(content.spans, firstBodyRow)
  let painter = painters.get(text)
  if (painter === undefined) {
    const styleIds = new Map<string, number>()
    painter = {
      styleIds,
      highlights: createViewportHighlights<AnsiPaint>(text, {
        buffer,
        paintLine: (row: number, current: AnsiPaint): void => {
          const spans = current.get(row)
          if (spans === undefined) return
          for (const span of spans) {
            buffer.addHighlight(row, { start: span.start, end: span.end, styleId: styleIdFor(buffer, styleIds, span) })
          }
        },
      }),
    }
    painters.set(text, painter)
  }
  painter.highlights.install(full, spansByRow)
}

/**
 * Hands the pane back to plain `update()` content, or to ./diff-text. The caller writes the
 * replacement text itself; this only drops this module's highlights so they cannot bleed into it.
 */
export function releaseAnsiText(text: TextRenderable): void {
  painters.get(text)?.highlights.release()
}

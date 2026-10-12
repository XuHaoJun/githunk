import { StyledText, bold as boldChunk, dim as dimChunk, fg as fgChunk, type TextChunk, type TextRenderable } from "@opentui/core"
import type { AnsiSpan } from "../ansi"
import type { InstalledPaneText } from "./diff-text"

/**
 * Pushes a git command's own coloured output into a pane's text viewport, the spans ../ansi recovered
 * from git's SGR sequences carried as styled chunks.
 *
 * OpenTUI 0.6 keeps the renderable tree native and leaves `TextRenderable.textBuffer` undefined, so
 * the line-indexed highlights 0.5 painted around the viewport are gone: the document is encoded
 * whole per changed install instead, and an unchanged install is free. lazygit gets the windowed
 * property for free because gocui parses SGR as it writes and never writes more than it displays
 * (pkg/gui/view_helpers.go:22 `linesToReadFromCmdTask`); here the display is one `StyledText`.
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

/** The content each pane was last installed with, colours included. */
const installedContents = new WeakMap<TextRenderable, string>()

function styleKey(span: AnsiSpan): string {
  const color = span.fg
  const colorKey = color === undefined ? "-" : `${color.intent}:${color.slot}:${color.toInts().join(",")}`
  return `${colorKey}|${span.bold === true ? "b" : "-"}${span.dim === true ? "d" : "-"}`
}

function countRows(value: string): number {
  let rows = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) rows++
  return rows
}

/** The preamble always ends at a row boundary, so the body's first row is its line count. */
function joined(content: AnsiTextContent): InstalledPaneText & { readonly firstBodyRow: number } {
  const preamble = content.preamble.length === 0 || content.preamble.endsWith("\n") ? content.preamble : `${content.preamble}\n`
  return { text: `${preamble}${content.body}`, preambleLength: preamble.length, firstBodyRow: countRows(preamble) }
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

/** The text plus every span's geometry and colours: a recolour without a text change still repaints. */
function contentSignature(installed: InstalledPaneText, spansByRow: AnsiPaint): string {
  const rows = [...spansByRow.entries()].sort(([left], [right]) => left - right)
  return `${installed.text}\u0002${rows.map(([row, spans]) => `${row}:${spans.map((span) => `${span.start}-${span.end}-${styleKey(span)}`).join(",")}`).join("|")}`
}

/** Encodes the whole document, each row's spans in their own colours. */
function paintAsChunks(text: TextRenderable, installed: InstalledPaneText & { readonly firstBodyRow: number }, spansByRow: AnsiPaint): InstalledPaneText {
  const { text: full } = installed
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
  return { text: installed.text, preambleLength: installed.preambleLength }
}

/**
 * Installs `content` as the pane's text. Re-installing byte-identical text with the same colours is a
 * no-op, which is what makes re-focusing a panel free.
 */
export function installAnsiText(text: TextRenderable, content: AnsiTextContent): InstalledPaneText {
  const installed = joined(content)
  const spansByRow = groupByRow(content.spans, installed.firstBodyRow)
  const signature = contentSignature(installed, spansByRow)
  if (installedContents.get(text) === signature) return { text: installed.text, preambleLength: installed.preambleLength }
  installedContents.set(text, signature)
  return paintAsChunks(text, installed, spansByRow)
}

/**
 * Forgets the installed content, so the next install writes even if it holds the same characters. The
 * caller writes the pane's replacement text itself.
 */
export function releaseAnsiText(text: TextRenderable): void {
  installedContents.delete(text)
}

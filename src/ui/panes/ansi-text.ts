import { StyledText, bold as boldChunk, dim as dimChunk, fg as fgChunk, type TextChunk, type TextRenderable } from "@opentui/core"
import type { AnsiSpan } from "../ansi"
import { paneTextBuffer, type PaneTextBuffer } from "./pane-text"

/**
 * Pushes a git command's own coloured output into a pane's text viewport, colouring only the rows
 * the viewport shows.
 *
 * The sibling of ./diff-text, and the same bargain: the text goes in unstyled and whole so OpenTUI
 * keeps owning scrolling, wrapping and selection, while the colours — here the spans ../ansi
 * recovered from git's SGR sequences — are painted lazily around the viewport. lazygit gets this
 * for free because gocui parses SGR as it writes and never writes more than it displays
 * (pkg/gui/view_helpers.go:22 `linesToReadFromCmdTask`).
 */

/**
 * Rows painted beyond the viewport on each side; the same slack ./diff-text keeps, and for the
 * same reason: the window is recomputed from `scrollY`/`height` read before layout runs.
 */
const MARGIN_ROWS = 32

export type AnsiTextContent = {
  /** Rendered ahead of the coloured body, unstyled (a tag's own metadata block); "" for none. */
  readonly preamble: string
  /** ../ansi's stripped text: exactly what the rows below hold. */
  readonly body: string
  /** ../ansi's spans, addressed in `body` rows — the preamble's height is added here. */
  readonly spans: readonly AnsiSpan[]
}

type AnsiTextState = {
  readonly buffer: PaneTextBuffer
  /** Style id per interned `(fg, bold, dim)` triple; ids are per text renderable. */
  readonly styleIds: Map<string, number>
  text: string
  /** Spans of each row, keyed by the row's index in the *pane*, preamble included. */
  spansByRow: ReadonlyMap<number, readonly AnsiSpan[]>
  rowSources: readonly number[] | undefined
  rowSourcesWidth: number
  appliedScrollY: number
  appliedHeight: number
  painted: { from: number; to: number } | undefined
}

const states = new WeakMap<TextRenderable, AnsiTextState>()
const hooked = new WeakSet<TextRenderable>()

function styleKey(span: AnsiSpan): string {
  const color = span.fg
  const colorKey = color === undefined ? "-" : `${color.intent}:${color.slot}:${color.toInts().join(",")}`
  return `${colorKey}|${span.bold === true ? "b" : "-"}${span.dim === true ? "d" : "-"}`
}

function styleIdFor(state: AnsiTextState, span: AnsiSpan): number {
  const key = styleKey(span)
  const existing = state.styleIds.get(key)
  if (existing !== undefined) return existing
  const id = state.buffer.registerStyle(`githunk.ansi.${key}`, {
    ...(span.fg === undefined ? {} : { fg: span.fg }),
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.dim === true ? { dim: true } : {}),
  })
  state.styleIds.set(key, id)
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

function groupByRow(spans: readonly AnsiSpan[], offset: number): ReadonlyMap<number, readonly AnsiSpan[]> {
  const grouped = new Map<number, AnsiSpan[]>()
  for (const span of spans) {
    const row = span.row + offset
    const existing = grouped.get(row)
    if (existing === undefined) grouped.set(row, [span])
    else existing.push(span)
  }
  return grouped
}

/** Repaints the highlight window when the viewport has moved since the last paint. */
function paintWindow(text: TextRenderable, force: boolean): void {
  const state = states.get(text)
  if (state === undefined) return
  const height = Math.max(1, Math.floor(text.height))
  const scrollY = Math.max(0, Math.floor(text.scrollY))
  if (!force && state.painted !== undefined && state.appliedScrollY === scrollY && state.appliedHeight === height) return

  const width = Math.max(1, Math.floor(text.width))
  if (state.rowSources === undefined || state.rowSourcesWidth !== width) {
    state.rowSources = text.lineInfo.lineSources
    state.rowSourcesWidth = width
  }
  const sources = state.rowSources
  const lastRow = Math.max(0, Math.min(scrollY + height - 1, sources.length - 1))
  const firstLine = sources[Math.min(scrollY, lastRow)] ?? scrollY
  const lastLine = sources[lastRow] ?? lastRow
  const from = Math.max(0, firstLine - MARGIN_ROWS)
  const to = lastLine + MARGIN_ROWS

  const paintRow = (row: number): void => {
    const spans = state.spansByRow.get(row)
    if (spans === undefined) return
    for (const span of spans) {
      state.buffer.addHighlight(row, { start: span.start, end: span.end, styleId: styleIdFor(state, span) })
    }
  }

  const previous = state.painted
  if (previous === undefined || previous.to < from || previous.from > to) {
    state.buffer.clearAllHighlights()
    for (let row = from; row <= to; row++) paintRow(row)
  } else {
    for (let row = previous.from; row < from; row++) state.buffer.clearRow(row)
    for (let row = to + 1; row <= previous.to; row++) state.buffer.clearRow(row)
    for (let row = from; row < previous.from; row++) paintRow(row)
    for (let row = previous.to + 1; row <= to; row++) paintRow(row)
  }
  state.painted = { from, to }
  state.appliedScrollY = scrollY
  state.appliedHeight = height
}

function hookLifecycle(text: TextRenderable): void {
  if (hooked.has(text)) return
  hooked.add(text)
  const host = text as unknown as { onLifecyclePass?: (() => void) | null }
  const previous = host.onLifecyclePass
  host.onLifecyclePass = () => {
    previous?.call(text)
    paintWindow(text, false)
  }
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
  let state = states.get(text)
  if (state === undefined) {
    state = {
      buffer,
      styleIds: new Map<string, number>(),
      text: "",
      spansByRow: new Map<number, readonly AnsiSpan[]>(),
      rowSources: undefined,
      rowSourcesWidth: -1,
      appliedScrollY: -1,
      appliedHeight: -1,
      painted: undefined,
    }
    states.set(text, state)
    hookLifecycle(text)
  }
  state.spansByRow = groupByRow(content.spans, firstBodyRow)
  const changed = state.text !== full
  if (changed) {
    state.text = full
    buffer.setText(full)
    state.rowSources = undefined
    state.painted = undefined
  }
  paintWindow(text, changed)
}

/**
 * Hands the pane back to plain `update()` content, or to ./diff-text. The caller writes the
 * replacement text itself; this only drops this module's highlights and state so they cannot
 * bleed into it.
 */
export function releaseAnsiText(text: TextRenderable): void {
  const state = states.get(text)
  if (state === undefined) return
  state.buffer.clearAllHighlights()
  states.delete(text)
}

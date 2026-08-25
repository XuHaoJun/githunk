import { StyledText, cyan, dim, green, red, type TextChunk, type TextRenderable } from "@opentui/core"
import type { DiffDisplayLine, DiffDisplayLineStyle } from "../../domain/diff/document"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"

/**
 * Pushes a rendered diff into a pane's text viewport, colouring only the rows the viewport shows.
 *
 * The text itself goes in unstyled and whole (see ./pane-text for why that is the cheap route),
 * so OpenTUI keeps owning scrolling, wrapping and selection over the complete patch. Only the
 * colours are lazy. That is lazygit's property too: its main view never processes more of a diff
 * than it is about to display (pkg/gui/view_helpers.go:22 `linesToReadFromCmdTask`).
 */

/** Column bound for "to the end of the row"; the native buffer clamps it to the real width. */
const ROW_END_COLS = 1_000_000

/**
 * Rows painted beyond the viewport on each side. The window is recomputed from the pane's own
 * `scrollY`/`height`, which a lifecycle pass reads *before* layout runs, so a resize can be one
 * frame late; a screenful of slack keeps that invisible.
 */
const MARGIN_ROWS = 32

/** Registered once per pane. The definitions mirror what the chunk fallback below paints. */
const STYLE_DEFINITIONS: Readonly<Record<"gutter" | Exclude<DiffDisplayLineStyle, "plain">, PaneStyleDefinition>> = {
  gutter: { dim: true },
  addition: { fg: "green" },
  deletion: { fg: "red" },
  "hunk-header": { fg: "cyan" },
  metadata: { dim: true },
}

export type DiffTextContent = {
  /** Rendered ahead of the diff (a commit's message and stat); "" for a bare patch. */
  readonly preamble: string
  /** `renderDiff`'s `displayText`: the gutter-prefixed rows, one per document line. */
  readonly body: string
  readonly displayLines: readonly DiffDisplayLine[]
}

type DiffTextState = {
  readonly buffer: PaneTextBuffer
  readonly styleIds: Readonly<Record<string, number>>
  text: string
  displayLines: readonly DiffDisplayLine[]
  firstDiffRow: number
  /**
   * Visual row → document line, from the pane's `lineInfo`. Only wrapping makes the two differ,
   * so it changes with the text or the wrap width — never with the scroll offset, which is why it
   * is cached: materialising it costs ~3 ms on a 75k-line patch, and scrolling asks every row.
   */
  rowSources: readonly number[] | undefined
  rowSourcesWidth: number
  appliedScrollY: number
  appliedHeight: number
  /** Inclusive row range currently carrying highlights, or undefined when none do. */
  painted: { from: number; to: number } | undefined
}

const states = new WeakMap<TextRenderable, DiffTextState>()
const hooked = new WeakSet<TextRenderable>()

function registerStyles(buffer: PaneTextBuffer): Readonly<Record<string, number>> {
  const ids: Record<string, number> = {}
  for (const [name, definition] of Object.entries(STYLE_DEFINITIONS)) {
    ids[name] = buffer.registerStyle(`githunk.diff.${name}`, definition)
  }
  return ids
}

function countRows(value: string): number {
  let rows = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) rows++
  return rows
}

/**
 * The preamble ends at a row boundary so the diff's first row is `countRows(preamble)`. `git show`
 * always puts the patch on its own line; normalising here keeps that an invariant rather than an
 * assumption, because every row-to-style mapping below depends on it.
 */
function joined(content: DiffTextContent): { readonly text: string; readonly firstDiffRow: number } {
  const preamble = content.preamble.length === 0 || content.preamble.endsWith("\n") ? content.preamble : `${content.preamble}\n`
  return { text: `${preamble}${content.body}`, firstDiffRow: countRows(preamble) }
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
    // A wrapped row above the viewport shifts every row below it, so the window is derived from
    // the row-to-line map rather than from `scrollY` directly.
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
    const display = state.displayLines[row - state.firstDiffRow]
    if (display === undefined) return
    if (display.gutterCols > 0) state.buffer.addHighlight(row, { start: 0, end: display.gutterCols, styleId: state.styleIds.gutter! })
    if (display.style !== "plain") state.buffer.addHighlight(row, { start: display.gutterCols, end: ROW_END_COLS, styleId: state.styleIds[display.style]! })
  }

  // Rows already painted stay painted: a highlight costs ~46 µs to add, so scrolling by a row must
  // touch a row, not a screenful. Clearing the whole buffer is free by comparison, so a jump that
  // leaves the painted band behind starts over.
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

/**
 * Follows the viewport for the rest of the pane's life. Every scroll path — keys, wheel, scrollbar
 * drag, reveal, resize — ends in a render, and OpenTUI runs registered lifecycle passes at the top
 * of one, so this is the single place that cannot be bypassed.
 */
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

function plainChunk(value: string): TextChunk {
  return { __isChunk: true, text: value } as TextChunk
}

function styledChunk(style: DiffDisplayLineStyle, value: string): TextChunk {
  if (style === "addition") return green(value)
  if (style === "deletion") return red(value)
  if (style === "hunk-header") return cyan(value)
  if (style === "metadata") return dim(value)
  return plainChunk(value)
}

/**
 * Whole-document chunk rendering: correct, and what this module exists to avoid. Reached only if a
 * future OpenTUI stops exposing the buffer, so the pane degrades in speed rather than colour.
 */
function paintAsChunks(text: TextRenderable, content: DiffTextContent): void {
  const { text: full, firstDiffRow } = joined(content)
  const rows = full.split("\n")
  const chunks: TextChunk[] = []
  for (let row = 0; row < rows.length; row++) {
    const value = `${rows[row]!}${row === rows.length - 1 ? "" : "\n"}`
    if (value.length === 0) continue
    const display = content.displayLines[row - firstDiffRow]
    if (display === undefined) {
      chunks.push(plainChunk(value))
      continue
    }
    const gutter = value.slice(0, display.gutterCols)
    const body = value.slice(display.gutterCols)
    if (gutter.length > 0) chunks.push(dim(gutter))
    if (body.length > 0) chunks.push(styledChunk(display.style, body))
  }
  text.content = new StyledText(chunks)
}

/**
 * Installs `content` as the pane's text. Re-installing the same text is a no-op beyond refreshing
 * the paint description, which is what makes re-focusing a panel free.
 */
export function installDiffText(text: TextRenderable, content: DiffTextContent): void {
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    paintAsChunks(text, content)
    return
  }
  const { text: full, firstDiffRow } = joined(content)
  let state = states.get(text)
  if (state === undefined) {
    state = {
      buffer,
      styleIds: registerStyles(buffer),
      text: "",
      displayLines: content.displayLines,
      firstDiffRow,
      rowSources: undefined,
      rowSourcesWidth: -1,
      appliedScrollY: -1,
      appliedHeight: -1,
      painted: undefined,
    }
    states.set(text, state)
    hookLifecycle(text)
  }
  state.displayLines = content.displayLines
  state.firstDiffRow = firstDiffRow
  const changed = state.text !== full
  if (changed) {
    state.text = full
    buffer.setText(full)
    state.rowSources = undefined
    // setText drops the buffer's highlights with the text it styled.
    state.painted = undefined
  }
  paintWindow(text, changed)
}

/**
 * Hands the pane back to plain `update()` content. The caller writes the replacement text itself;
 * this only drops the diff's highlights so they cannot bleed into it.
 */
export function releaseDiffText(text: TextRenderable): void {
  const state = states.get(text)
  if (state === undefined) return
  state.buffer.clearAllHighlights()
  states.delete(text)
}

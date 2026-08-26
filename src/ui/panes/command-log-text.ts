import type { TextRenderable } from "@opentui/core"
import type { CommandLogLine, CommandLogStyle } from "../../domain/command"
import { ANSI_CYAN, ANSI_GREEN, ANSI_MAGENTA, ANSI_YELLOW, DEFAULT_FOREGROUND } from "../theme"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"

/**
 * Paints the command log's colours, following src/ui/panes/diff-text.ts: the text goes in whole and
 * unstyled (see ./pane-text for why that is the cheap route), OpenTUI owns wrapping and scrolling,
 * and only the rows near the viewport carry highlights.
 *
 * lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150) and gocui wraps at character
 * boundaries; the pane sets `wrapMode: "char"` to match. Letting the widget wrap is what keeps this
 * file free of column arithmetic: nothing in githunk measures East Asian width, and every log line
 * but the random tip carries a single span, so its rows paint whole.
 */

/** Column bound for "to the end of the row"; the native buffer clamps it to the real width. */
export const ROW_END_COLS = 1_000_000

/** Rows painted beyond the viewport on each side, as in diff-text.ts:23. */
const MARGIN_ROWS = 32

/**
 * lazygit's colours. `command` is `theme.DefaultTextColor`, which is `style.FgDefault`
 * (pkg/theme/theme.go:11) — the terminal's own foreground, not a fixed white.
 */
const STYLE_DEFINITIONS: Readonly<Record<CommandLogStyle, PaneStyleDefinition>> = {
  // `style.FgYellow.Sprint(action)` (pkg/gui/command_log_panel.go:41).
  action: { fg: ANSI_YELLOW },
  command: { fg: DEFAULT_FOREGROUND },
  // "if we're not dealing with a direct command that could be run on the command line, we style it
  // differently to communicate that" (pkg/gui/command_log_panel.go:52-56).
  internal: { fg: ANSI_MAGENTA },
  // `style.FgMagenta.Sprintf("\n\n%s\n", Tr.GitOutput)` (pkg/gui/extras_panel.go:97).
  "output-heading": { fg: ANSI_MAGENTA },
  output: { fg: DEFAULT_FOREGROUND },
  // `style.FgCyan.Sprint(introStr)` (pkg/gui/command_log_panel.go:75).
  intro: { fg: ANSI_CYAN },
  // `style.FgYellow.Sprint(Tr.RandomTip)` / `style.FgGreen.Sprint(tip)` (:81-82).
  "tip-label": { fg: ANSI_YELLOW },
  tip: { fg: ANSI_GREEN },
}

export type CommandLogRowHighlight = {
  readonly start: number
  readonly end: number
  readonly style: CommandLogStyle
}

/**
 * The highlights one *visual* row needs. `lineSources` is OpenTUI's visual row → logical line map.
 *
 * A row belonging to a single-span line paints whole, so wrapping and character width are the
 * widget's problem, not this function's. The only multi-span line is `Random tip: <tip>`: its first
 * row splits at the label's code-point boundary, and any row it wrapped onto takes the trailing
 * span's style — the label cannot reach a continuation row, being the first thing on the line.
 */
export function commandLogRowHighlights(
  lines: readonly CommandLogLine[],
  lineSources: readonly number[],
  row: number,
): readonly CommandLogRowHighlight[] {
  const source = lineSources[row]
  if (source === undefined) return []
  const line = lines[source]
  if (line === undefined || line.spans.length === 0) return []
  const last = line.spans[line.spans.length - 1]!
  if (line.spans.length === 1) return [{ start: 0, end: ROW_END_COLS, style: last.style }]
  if (lineSources[row - 1] === source) return [{ start: 0, end: ROW_END_COLS, style: last.style }]

  const highlights: CommandLogRowHighlight[] = []
  let column = 0
  for (const [index, span] of line.spans.entries()) {
    // Code points, not UTF-16 units: an astral character is one column's worth of text as far as
    // the buffer's column indexing is concerned.
    const width = [...span.text].length
    const isLast = index === line.spans.length - 1
    highlights.push({ start: column, end: isLast ? ROW_END_COLS : column + width, style: span.style })
    column += width
  }
  return highlights
}

type CommandLogTextState = {
  readonly buffer: PaneTextBuffer
  readonly styleIds: Readonly<Record<CommandLogStyle, number>>
  text: string
  lines: readonly CommandLogLine[]
  /** Visual row → logical line, cached per wrap width exactly as diff-text.ts:104-108 does. */
  rowSources: readonly number[] | undefined
  rowSourcesWidth: number
  appliedScrollY: number
  appliedHeight: number
  /** Inclusive visual-row range currently carrying highlights, or undefined when none do. */
  painted: { from: number; to: number } | undefined
}

const states = new WeakMap<TextRenderable, CommandLogTextState>()
const hooked = new WeakSet<TextRenderable>()

function registerStyles(buffer: PaneTextBuffer): Readonly<Record<CommandLogStyle, number>> {
  const ids: Partial<Record<CommandLogStyle, number>> = {}
  for (const [name, definition] of Object.entries(STYLE_DEFINITIONS) as [CommandLogStyle, PaneStyleDefinition][]) {
    ids[name] = buffer.registerStyle(`githunk.commandLog.${name}`, definition)
  }
  return ids as Readonly<Record<CommandLogStyle, number>>
}

/**
 * Paints (or clears) one *visual* row, but only when it is the first visual row of its logical
 * line.
 *
 * `PaneTextBuffer.addHighlight`/`clearRow` reach OpenTUI's `TextBuffer.addHighlight` /
 * `clearLineHighlights`, which the type declarations (and, checked empirically against 0.5.6's
 * TextBufferRenderable — its `textBuffer` is the pre-wrap buffer, kept separate from the wrapped
 * `textBufferView` that produces `lineInfo`) address by *logical* line, not by the visual row
 * `lineSources` is indexed by. `commandLogRowHighlights`'s last span always ends at `ROW_END_COLS`,
 * and that bound reaches the end of the whole logical line — confirmed the same way — so one call
 * from the line's first visual row already colours every row it wraps onto. Calling it again from a
 * continuation row would be a second, overlapping highlight on the same logical line with no
 * documented precedence between the two, so continuation rows are skipped rather than repainted.
 */
function firstVisualRowOf(sources: readonly number[], row: number): number | undefined {
  const source = sources[row]
  if (source === undefined || sources[row - 1] === source) return undefined
  return source
}

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
  let from = Math.max(0, scrollY - MARGIN_ROWS)
  // A row is only ever painted from its logical line's first visual row (see firstVisualRowOf). If
  // `from` lands mid-wrap, that first row sits above it and this window would never reach it, so
  // `from` is walked back to the line's own start.
  while (from > 0 && sources[from - 1] === sources[from]) from--
  const to = Math.min(sources.length - 1, scrollY + height - 1 + MARGIN_ROWS)

  const paintRow = (row: number): void => {
    const source = firstVisualRowOf(sources, row)
    if (source === undefined) return
    for (const highlight of commandLogRowHighlights(state.lines, sources, row)) {
      state.buffer.addHighlight(source, { start: highlight.start, end: highlight.end, styleId: state.styleIds[highlight.style] })
    }
  }
  const clearRow = (row: number): void => {
    const source = firstVisualRowOf(sources, row)
    if (source === undefined) return
    state.buffer.clearRow(source)
  }

  // Rows already painted stay painted: a highlight costs ~46 µs to add, so scrolling by a row must
  // touch a row, not a screenful (diff-text.ts:120-133).
  const previous = state.painted
  if (previous === undefined || previous.to < from || previous.from > to) {
    state.buffer.clearAllHighlights()
    for (let row = from; row <= to; row++) paintRow(row)
  } else {
    for (let row = previous.from; row < from; row++) clearRow(row)
    for (let row = to + 1; row <= previous.to; row++) clearRow(row)
    for (let row = from; row < previous.from; row++) paintRow(row)
    for (let row = previous.to + 1; row <= to; row++) paintRow(row)
  }
  state.painted = { from, to }
  state.appliedScrollY = scrollY
  state.appliedHeight = height
}

/** Follows the viewport for the rest of the pane's life, as diff-text.ts:138-152 does. */
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
 * Installs `lines` as the pane's text and colours the rows near the viewport. Re-installing the
 * same lines only refreshes the paint description, which is what makes a no-op refresh free.
 *
 * If a future OpenTUI stops exposing the buffer, the log degrades to uncoloured rather than
 * unrendered — the same trade `installDiffText` makes.
 */
export function installCommandLogText(text: TextRenderable, lines: readonly CommandLogLine[]): void {
  const full = lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    text.content = full
    return
  }
  let state = states.get(text)
  if (state === undefined) {
    state = {
      buffer,
      styleIds: registerStyles(buffer),
      text: "",
      lines,
      rowSources: undefined,
      rowSourcesWidth: -1,
      appliedScrollY: -1,
      appliedHeight: -1,
      painted: undefined,
    }
    states.set(text, state)
    hookLifecycle(text)
  }
  state.lines = lines
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

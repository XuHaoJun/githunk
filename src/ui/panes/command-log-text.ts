import type { TextRenderable } from "@opentui/core"
import type { CommandLogLine, CommandLogStyle } from "../../domain/command"
import { cellWidth } from "../cell-width"
import { ANSI_CYAN, ANSI_GREEN, ANSI_MAGENTA, ANSI_YELLOW, DEFAULT_FOREGROUND } from "../theme"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"

/**
 * Paints the command log's colours, following src/ui/panes/diff-text.ts: the text goes in whole and
 * unstyled (see ./pane-text for why that is the cheap route), OpenTUI owns wrapping and scrolling,
 * and only the rows near the viewport carry highlights.
 *
 * lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150) and gocui wraps at character
 * boundaries; the pane sets `wrapMode: "char"` to match. Letting the widget wrap is what keeps the
 * column arithmetic here to a single boundary: every log line but the random tip carries one span,
 * so it paints whole, and the tip's label/tip split is the only column this file has to measure.
 */

/** Column bound for "to the end of the line"; the native buffer clamps it to the real width. */
export const LINE_END_COLS = 1_000_000

/** Logical lines painted beyond the viewport on each side, as in diff-text.ts:23. */
const MARGIN_LINES = 32

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

export type CommandLogHighlight = {
  readonly start: number
  readonly end: number
  readonly style: CommandLogStyle
}

/**
 * The highlights one *logical* (pre-wrap) line needs, in that line's own column space.
 *
 * Logical lines are the unit because that is what `PaneTextBuffer.addHighlight` addresses (see
 * `paintLine`), and a highlight reaching `LINE_END_COLS` therefore covers every visual row the line
 * wrapped onto — wrapping is the widget's problem, not this function's.
 *
 * The only multi-span line is `Random tip: <tip>`, so the label/tip boundary is the one column this
 * file measures. It is measured in **display cells** (../cell-width), which is the unit
 * `addHighlight`'s columns count: probed against OpenTUI 0.5.6 by highlighting `[0, 8)` of
 * `"中 tip: GREEN"` and of `"🎲 tip: GREEN"` and getting back `"中 tip: "` and `"🎲 tip: "` — 6 code
 * points each, 7 and 8 UTF-16 units, 8 cells each. Under code-point or UTF-16 semantics the label's
 * trailing space would fall to the tip's colour.
 */
export function commandLogLineHighlights(line: CommandLogLine): readonly CommandLogHighlight[] {
  if (line.spans.length === 0) return []
  const last = line.spans[line.spans.length - 1]!
  if (line.spans.length === 1) return [{ start: 0, end: LINE_END_COLS, style: last.style }]

  const highlights: CommandLogHighlight[] = []
  let column = 0
  for (const [index, span] of line.spans.entries()) {
    const isLast = index === line.spans.length - 1
    const width = cellWidth(span.text)
    highlights.push({ start: column, end: isLast ? LINE_END_COLS : column + width, style: span.style })
    column += width
  }
  return highlights
}

type CommandLogTextState = {
  readonly buffer: PaneTextBuffer
  readonly styleIds: Readonly<Record<CommandLogStyle, number>>
  text: string
  lines: readonly CommandLogLine[]
  /** Visual row → logical line, cached per wrap width exactly as diff-text.ts:97-102 does. */
  rowSources: readonly number[] | undefined
  rowSourcesWidth: number
  appliedScrollY: number
  appliedHeight: number
  /** Inclusive logical-line range currently carrying highlights, or undefined when none do. */
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
 * Repaints the highlight band when the viewport has moved since the last paint.
 *
 * Everything here counts *logical* lines, not visual rows. `PaneTextBuffer.addHighlight`/`clearRow`
 * reach OpenTUI's `TextBuffer.addHighlight` / `clearLineHighlights`, which address the pre-wrap
 * buffer — checked empirically against 0.5.6, whose `TextBufferRenderable` keeps that buffer
 * separate from the wrapped `textBufferView` that produces `lineInfo`. So the band is derived from
 * the row-to-line map the way diff-text.ts:104-108 derives it, and a line painted once is coloured
 * on every visual row it wrapped onto.
 */
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
  const from = Math.max(0, firstLine - MARGIN_LINES)
  const to = lastLine + MARGIN_LINES

  const paintLine = (line: number): void => {
    const entry = state.lines[line]
    if (entry === undefined) return
    for (const highlight of commandLogLineHighlights(entry)) {
      state.buffer.addHighlight(line, { start: highlight.start, end: highlight.end, styleId: state.styleIds[highlight.style] })
    }
  }

  // Lines already painted stay painted: a highlight costs ~46 µs to add, so scrolling by a row must
  // touch a line, not a screenful (diff-text.ts:117-129).
  const previous = state.painted
  if (previous === undefined || previous.to < from || previous.from > to) {
    state.buffer.clearAllHighlights()
    for (let line = from; line <= to; line++) paintLine(line)
  } else {
    for (let line = previous.from; line < from; line++) state.buffer.clearRow(line)
    for (let line = to + 1; line <= previous.to; line++) state.buffer.clearRow(line)
    for (let line = from; line < previous.from; line++) paintLine(line)
    for (let line = previous.to + 1; line <= to; line++) paintLine(line)
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

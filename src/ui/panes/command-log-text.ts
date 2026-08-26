import type { TextRenderable } from "@opentui/core"
import type { CommandLogLine, CommandLogStyle } from "../../domain/command"
import { cellWidth } from "../cell-width"
import { ANSI_CYAN, ANSI_GREEN, ANSI_MAGENTA, ANSI_YELLOW, DEFAULT_FOREGROUND } from "../theme"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"
import { createViewportHighlights, type ViewportHighlights } from "./viewport-highlights"

/**
 * Paints the command log's colours. The text goes in whole and unstyled and only the lines near the
 * viewport carry colour; ./viewport-highlights owns that mechanism, as it does for ./diff-text. This
 * file owns what is the log's own: the styles, and one line's highlights.
 *
 * lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150) and gocui wraps at character
 * boundaries; the pane sets `wrapMode: "char"` to match. Letting the widget wrap is what keeps the
 * column arithmetic here to a single boundary: every log line but the random tip carries one span,
 * so it paints whole, and the tip's label/tip split is the only column this file has to measure.
 */

/** Column bound for "to the end of the line"; the native buffer clamps it to the real width. */
export const LINE_END_COLS = 1_000_000

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
 * ./viewport-highlights), and a highlight reaching `LINE_END_COLS` therefore covers every visual row
 * the line wrapped onto — wrapping is the widget's problem, not this function's.
 *
 * The only multi-span line is `Random tip: <tip>`, so the label/tip boundary is the one column this
 * file measures. It is measured in **display cells** (../cell-width), which is the unit
 * `addHighlight`'s columns count: probed against OpenTUI 0.5.6 by highlighting `[0, 8)` of
 * `"中 tip: GREEN"` and of `"🎲 tip: GREEN"` and getting back `"中 tip: "` and `"🎲 tip: "` — 7 code
 * points each, 7 and 8 UTF-16 units, 8 cells each. Code points end either label at column 7 — where
 * the `[0, 7)` probe stopped, on `"中 tip:"` — handing the label's trailing space to the tip's
 * colour; UTF-16 units do that to 中's label too, and only coincide with cells for the emoji's.
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

function registerStyles(buffer: PaneTextBuffer): Readonly<Record<CommandLogStyle, number>> {
  const ids: Partial<Record<CommandLogStyle, number>> = {}
  for (const [name, definition] of Object.entries(STYLE_DEFINITIONS) as [CommandLogStyle, PaneStyleDefinition][]) {
    ids[name] = buffer.registerStyle(`githunk.commandLog.${name}`, definition)
  }
  return ids as Readonly<Record<CommandLogStyle, number>>
}

const painters = new WeakMap<TextRenderable, ViewportHighlights<readonly CommandLogLine[]>>()

/**
 * Installs `lines` as the pane's text and colours the lines near the viewport. Re-installing the
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
  let painter = painters.get(text)
  if (painter === undefined) {
    const styleIds = registerStyles(buffer)
    painter = createViewportHighlights<readonly CommandLogLine[]>(text, {
      buffer,
      paintLine: (index: number, current: readonly CommandLogLine[]): void => {
        const line = current[index]
        if (line === undefined) return
        for (const highlight of commandLogLineHighlights(line)) {
          buffer.addHighlight(index, { start: highlight.start, end: highlight.end, styleId: styleIds[highlight.style] })
        }
      },
    })
    painters.set(text, painter)
  }
  painter.install(full, lines)
}

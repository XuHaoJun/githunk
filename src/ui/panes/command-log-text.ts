import { StyledText, fg, type ColorInput, type TextChunk, type TextRenderable } from "@opentui/core"
import type { CommandLogLine, CommandLogStyle } from "../../domain/command"
import { ANSI_CYAN, ANSI_GREEN, ANSI_MAGENTA, ANSI_YELLOW, DEFAULT_FOREGROUND } from "../theme"

/**
 * Colours the command log by encoding each line's spans as styled chunks.
 *
 * OpenTUI 0.6 keeps the renderable tree native and leaves `TextRenderable.textBuffer` undefined, so
 * the line-indexed highlights 0.5 addressed are gone: every span carries its own colour instead.
 * That costs the log's own length per changed install and, with the unchanged-content check below,
 * nothing at all on a no-op refresh.
 *
 * lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:158) and gocui wraps at character
 * boundaries; the pane sets `wrapMode: "char"` to match. Letting the widget wrap keeps column
 * arithmetic out of this file: a span's own text carries its colour onto every visual row it wraps
 * onto, so the tip's label/tip boundary is exact without measuring anything.
 */

/**
 * lazygit's colours. `command` is `theme.DefaultTextColor`, which is `style.FgDefault`
 * (pkg/theme/theme.go:11) — the terminal's own foreground, not a fixed white.
 */
const FOREGROUND_BY_STYLE: Readonly<Record<CommandLogStyle, ColorInput>> = {
  // `style.FgYellow.Sprint(action)` (pkg/gui/command_log_panel.go:41).
  action: ANSI_YELLOW,
  command: DEFAULT_FOREGROUND,
  // "if we're not dealing with a direct command that could be run on the command line, we style it
  // differently to communicate that" (pkg/gui/command_log_panel.go:52-56).
  internal: ANSI_MAGENTA,
  // `style.FgMagenta.Sprintf("\n\n%s\n", Tr.GitOutput)` (pkg/gui/extras_panel.go:97).
  "output-heading": ANSI_MAGENTA,
  output: DEFAULT_FOREGROUND,
  // `style.FgCyan.Sprint(introStr)` (pkg/gui/command_log_panel.go:75).
  intro: ANSI_CYAN,
  // `style.FgYellow.Sprint(Tr.RandomTip)` / `style.FgGreen.Sprint(tip)` (:81-82).
  "tip-label": ANSI_YELLOW,
  tip: ANSI_GREEN
}

/**
 * The content each pane was last installed with, styles included: a line whose text is unchanged but
 * whose style is not (an action that becomes a plain command) still has to be repainted.
 */
const installedContents = new WeakMap<TextRenderable, string>()

function contentOf(lines: readonly CommandLogLine[]): string {
  return lines.map((line) => line.spans.map((span) => `${span.style}\u0000${span.text}`).join("\u0001")).join("\n")
}

/**
 * Installs `lines` as the pane's text, each span in its own colour. Re-installing identical content
 * is a no-op, which is what makes a no-op refresh free.
 */
export function installCommandLogText(text: TextRenderable, lines: readonly CommandLogLine[]): void {
  const content = contentOf(lines)
  if (installedContents.get(text) === content) return
  installedContents.set(text, content)
  const chunks: TextChunk[] = []
  for (const [index, line] of lines.entries()) {
    if (index > 0) chunks.push({ __isChunk: true, text: "\n" })
    for (const span of line.spans) {
      if (span.text.length === 0) continue
      chunks.push(fg(FOREGROUND_BY_STYLE[span.style])(span.text))
    }
  }
  text.content = new StyledText(chunks)
}

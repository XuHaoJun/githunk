import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { ANSI_GREEN, DEFAULT_FOREGROUND } from "../theme"
import { attachVerticalScrollbar, syncVerticalScrollbar } from "./common"
import { installCommandLogText } from "./command-log-text"
import { autoscrollAfter, type CommandLogScrollInput } from "./command-log-scroll"
import type { FocusId } from "../focus"
import type { CommandLogLine } from "../../domain/command"

export type CommandLogPaneHandle = {
  readonly id: FocusId
  readonly box: BoxRenderable
  readonly text: TextRenderable
  resize(width: number, height: number): void
  update(lines: readonly CommandLogLine[]): void
  setFocused(focused: boolean): void
  scrollBy(delta: number): void
  scrollTo(position: number): void
  maxScrollY(): number
  /** lazygit's `view.Autoscroll` (pkg/gui/extras_panel.go). */
  autoscroll: boolean
  /** Applies one of lazygit's autoscroll transitions and re-pins the viewport if it is armed. */
  applyScrollInput(input: CommandLogScrollInput): void
}

export function createCommandLogPane(renderer: CliRenderer, lines: readonly CommandLogLine[]): CommandLogPaneHandle {
  const box = new BoxRenderable(renderer, {
    id: "command-log-pane",
    border: true,
    borderColor: DEFAULT_FOREGROUND,
    focusedBorderColor: ANSI_GREEN,
    titleColor: DEFAULT_FOREGROUND,
    // `Tr.ExtrasTitle` / `Tr.CommandLog` (pkg/i18n/english.go:1928,1946) — lowercase "log".
    title: "Command log",
    position: "absolute",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  })
  const text = new TextRenderable(renderer, {
    id: "command-log-text",
    content: "",
    fg: DEFAULT_FOREGROUND,
    selectable: false,
    // lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150); gocui wraps at
    // character boundaries, which is `"char"` here. Letting OpenTUI wrap is also what lets
    // command-log-text.ts colour whole logical lines instead of laying out visual rows itself.
    wrapMode: "char",
    width: "100%",
  })
  box.add(text)
  const bar = attachVerticalScrollbar(box, text, "command-log")
  let rendered: { readonly count: number; readonly newest: CommandLogLine | undefined } | undefined
  // `gui.Views.Extras.Autoscroll = true` at startup (pkg/gui/views.go:149).
  let autoscroll = true
  const pane: CommandLogPaneHandle = {
    id: "command-log",
    box,
    text,
    resize(width: number, height: number) {
      text.width = Math.max(1, Math.floor(width) - 2)
      text.height = Math.max(1, Math.floor(height) - 2)
      if (autoscroll) text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
    update(nextLines: readonly CommandLogLine[]) {
      // `CommandLog.lines()` hands back the same array it appends to, so identity cannot detect a
      // new line. The count plus the newest line's identity can, and skipping an unchanged log is
      // what keeps it off the cost of every layout pass and refresh.
      if (rendered !== undefined && rendered.count === nextLines.length && rendered.newest === nextLines[nextLines.length - 1]) return
      rendered = { count: nextLines.length, newest: nextLines[nextLines.length - 1] }
      installCommandLogText(text, nextLines)
      // Only when armed. lazygit's autoscroll is a view flag, not a property of writing
      // (pkg/gui/extras_panel.go:48-94); the caller decides whether an append armed it, because
      // only the caller knows whether it was an entry or the output under one.
      if (autoscroll) text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
    setFocused(focused: boolean) {
      box.borderColor = focused ? ANSI_GREEN : DEFAULT_FOREGROUND
      box.titleColor = focused ? ANSI_GREEN : DEFAULT_FOREGROUND
      box.requestRender()
    },
    scrollBy(delta: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, text.scrollY + delta))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    scrollTo(position: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, position))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    maxScrollY() {
      return text.maxScrollY
    },
    get autoscroll() {
      return autoscroll
    },
    set autoscroll(value: boolean) {
      autoscroll = value
    },
    applyScrollInput(input: CommandLogScrollInput) {
      autoscroll = autoscrollAfter(autoscroll, input)
      if (autoscroll) {
        text.scrollY = text.maxScrollY
        syncVerticalScrollbar(bar, text)
        box.requestRender()
      }
    },
  }
  pane.update(lines)
  return pane
}

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
  // The same local-default suppression every other pane gets from `createPane`
  // (src/ui/panes/common.ts:177-184). OpenTUI 0.5.6's `TextBufferRenderable.onMouseEvent` scrolls
  // the view itself on a wheel event and never consults `defaultPrevented`
  // (node_modules/@opentui/core/chunk-bun-da1keqyp.js:2814-2833), so the handler has to be replaced
  // rather than merely prevented. It deliberately does *not* `stopPropagation()`:
  // `processMouseEvent` keeps bubbling the event to the parent chain (`:1259-1266`) up to
  // RootView's single wheel dispatcher, which owns the scroll distance for every pane and — for
  // this one — clears autoscroll, the way lazygit's wheel binding over the extras view runs
  // `scrollUpExtra`/`scrollDownExtra` (pkg/gui/keybindings.go:248-258), both of which assign
  // `Autoscroll = false` (pkg/gui/extras_panel.go:49,57). Without the suppression one tick applies
  // two independent scrolls, and only the bubbled one goes through the transition.
  const originalTextMouseEvent = (text as unknown as { onMouseEvent?: (event: MouseEvent) => void }).onMouseEvent?.bind(text)
  ;(text as unknown as { onMouseEvent: (event: MouseEvent) => void }).onMouseEvent = (event: MouseEvent) => {
    if ((event as unknown as { type: string }).type === "scroll") {
      event.preventDefault()
      return
    }
    originalTextMouseEvent?.(event)
  }
  const bar = attachVerticalScrollbar(box, text, "command-log")
  let rendered: { readonly count: number; readonly newest: CommandLogLine | undefined } | undefined
  // `gui.Views.Extras.Autoscroll = true` at startup (pkg/gui/views.go:149).
  let autoscroll = true
  // Closes the shrinking-direction gap left by resize()'s immediate pin (see the comment
  // there): compose onto attachVerticalScrollbar's box.onSizeChange (it fires reliably on a
  // real resize — chunk-node-ks0581vk.js:967-969,2488-2743 — unlike text.onSizeChange, which
  // never fires at all, chunk-node-ks0581vk.js:3001-3007) a `queueMicrotask` that re-pins once
  // the frame's Yoga traversal has actually finished. Both matter: box.onSizeChange itself
  // fires *before* text's own `_heightValue` refreshes, because a parent's updateFromLayout()
  // (and the resize hooks it fires) runs before it recurses into children's
  // (chunk-node-ks0581vk.js:1120 vs. 1156-1158) — so reading text.height synchronously inside
  // this handler would be exactly as stale as reading it synchronously inside resize(). Only
  // deferring past the *end* of that synchronous traversal, via a microtask, reaches a point
  // where text.height is fresh.
  const originalBoxOnSizeChange = box.onSizeChange
  box.onSizeChange = () => {
    originalBoxOnSizeChange?.()
    if (!autoscroll) return
    queueMicrotask(() => {
      if (!autoscroll) return
      text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    })
  }
  const pane: CommandLogPaneHandle = {
    id: "command-log",
    box,
    text,
    resize(width: number, height: number) {
      const contentHeight = Math.max(1, Math.floor(height) - 2)
      text.width = Math.max(1, Math.floor(width) - 2)
      text.height = contentHeight
      // `text.maxScrollY` subtracts `text.height`'s *getter* from scrollHeight, and that getter
      // only refreshes from Yoga once per render pass (chunk-node-ks0581vk.js:901-921's
      // `updateFromLayout`, gated by `_lastLayoutFrame`) — so right after the assignment above it
      // would still read the pane's height from before this resize. That was invisible before
      // Task 9, when a focus change never resized the log at all; now that a focused log can grow
      // to `logCapacity` (getExtrasWindowSize's baseSize 1000 branch), pinning through the stale
      // getter re-armed the *old*, smaller viewport's bottom instead of the new one. Compute the
      // target from the content height just set instead.
      //
      // That fixes growing exactly: the `scrollY` setter (chunk-node-ks0581vk.js:2847-2853) also
      // clamps against the same stale getter, i.e. `min(target, scrollHeight - H_old)`, and for
      // growing (`H_new > H_old`) the correct target `scrollHeight - H_new` is always ≤ that
      // stale bound, so it passes through unclamped. Shrinking (`H_new < H_old`) is the opposite:
      // the correct target *exceeds* the stale bound, so the setter clamps the pin short by
      // `H_old - H_new` rows. The `box.onSizeChange` handler wired above closes that gap once
      // `text.height` is actually fresh, by re-running this same assignment through
      // `text.maxScrollY` instead of a locally computed target.
      if (autoscroll) text.scrollY = Math.max(0, text.scrollHeight - contentHeight)
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

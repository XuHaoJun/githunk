/**
 * lazygit's `view.Autoscroll` for the extras view, as a pure transition.
 *
 * The handlers are all in pkg/gui/extras_panel.go and they are blunt: every scroll handler assigns
 * `Autoscroll = false` — `scrollUpExtra` (:49), `scrollDownExtra` (:57), `pageUpExtrasPanel` (:65),
 * `pageDownExtrasPanel` (:73), `goToExtrasPanelTop` (:81) — except `goToExtrasPanelBottom`, which
 * assigns `true` (:89). So scrolling *down* to the bottom by hand does not re-arm it; `>` does. The
 * other two ways it comes back on are a new log entry (`LogAction`/`LogCommand`,
 * pkg/gui/command_log_panel.go:38,62) and losing focus
 * (pkg/gui/controllers/command_log_controller.go:29-33).
 */
export type CommandLogScrollInput =
  /** `LogAction` or `LogCommand`, both of which assign `Autoscroll = true`. */
  | "append-entry"
  /**
   * The `prefixWriter`'s output. It writes straight to the view
   * (pkg/gui/extras_panel.go:109-119) and never assigns `Autoscroll`; it scrolls only because the
   * `logCommand` before it already armed the flag.
   */
  | "append-output"
  /** `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-85), likewise. */
  | "append-header"
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "goto-top"
  | "goto-bottom"
  | "focus-lost"
  /**
   * Not a lazygit concept — lazygit has no scrollbar over the extras view, so there is no parity
   * behaviour to copy for the draggable one this pane has (one of githunk's three documented review
   * extensions, docs/lazygit-compatibility-v0.1.md). Wired by analogy to the principle the rest of
   * this FSM already encodes: every explicit user scroll clears the flag and only an explicit
   * jump-to-bottom arms it. A scrollbar drag is an explicit user scroll, so — like scroll-up/
   * scroll-down/page-up/page-down/goto-top — it clears the flag regardless of which way it moved.
   */
  | "scrollbar"
  /** Not a lazygit concept; a resize must not change what the user was reading. */
  | "resize"

export function autoscrollAfter(current: boolean, input: CommandLogScrollInput): boolean {
  switch (input) {
    case "append-entry":
    case "goto-bottom":
    case "focus-lost":
      return true
    case "scroll-up":
    case "scroll-down":
    case "page-up":
    case "page-down":
    case "goto-top":
    case "scrollbar":
      return false
    case "append-output":
    case "append-header":
    case "resize":
      return current
    default: {
      const unhandled: never = input
      return unhandled
    }
  }
}

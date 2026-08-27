export const FOCUS_IDS = ["main", "status", "files", "branches", "commits", "stash"] as const
export const COMMAND_LOG_FOCUS_ID = "command-log" as const
export type FocusId = (typeof FOCUS_IDS)[number] | typeof COMMAND_LOG_FOCUS_ID

export function focusIdForKey(key: string): FocusId | undefined {
  const index = Number.parseInt(key, 10)
  return Number.isInteger(index) && index >= 0 && index < FOCUS_IDS.length ? FOCUS_IDS[index] : undefined
}

export type FocusChange = (focus: FocusId, logVisible: boolean) => void

import type { SideWindow } from "./layout"

const SIDE_IDS: Record<string, true> = { status: true, files: true, branches: true, commits: true, stash: true }

function isSideWindowId(id: string): id is SideWindow {
  return SIDE_IDS[id] === true
}

export class FocusManager {
  active: FocusId = "main"
  logVisible = false
  onChange: FocusChange | undefined
  lastSide: SideWindow = "files"

  focus(id: FocusId): void {
    if (id === COMMAND_LOG_FOCUS_ID && !this.logVisible) return
    if (isSideWindowId(id)) this.lastSide = id
    this.active = id
    this.onChange?.(this.active, this.logVisible)
  }

  /**
   * The visibility half of what the old direct `@` cycle did in one step (focus.ts's previous
   * `handleKey` branch): flip `logVisible` and fire `onChange` the same way `focus()` does, so
   * RootView's cascade — including re-arming the command log's autoscroll, `refreshCommandLog`'s
   * "consume the batch's arm count on reopen" comparison — runs on a visibility change exactly as
   * it always has, whether or not `active` also moves. lazygit's `t` menu item
   * (extras_panel.go:19-29) and githunk's own double-click gesture on the horizontal splitter
   * share this.
   */
  setLogVisible(visible: boolean): void {
    this.logVisible = visible
    this.onChange?.(this.active, this.logVisible)
  }

  cycle(direction: "next" | "previous"): void {
    const next = direction === "next"
      ? nextFocus(this.active, this.logVisible)
      : previousFocus(this.active, this.logVisible)
    this.focus(next)
  }

  /**
   * lazygit's `@` opens a menu (pkg/gui/keybindings.go:171-174 -> pkg/gui/extras_panel.go:12-38)
   * rather than cycling, and RootView owns menus, so FocusManager only ever handles the numbered
   * focus keys here.
   */
  handleKey(key: string): boolean {
    const numbered = focusIdForKey(key)
    if (numbered === undefined) return false
    this.focus(numbered)
    return true
  }
}

/** Cycle order for h/l and tab: the main pane, then the five left panes, then the log when it is shown. */
function cycleOrder(logVisible: boolean): readonly FocusId[] {
  return logVisible ? [...FOCUS_IDS, COMMAND_LOG_FOCUS_ID] : FOCUS_IDS
}

export function nextFocus(current: FocusId, logVisible: boolean): FocusId {
  const order = cycleOrder(logVisible)
  const index = order.indexOf(current)
  return order[(index + 1) % order.length] ?? current
}

export function previousFocus(current: FocusId, logVisible: boolean): FocusId {
  const order = cycleOrder(logVisible)
  const index = order.indexOf(current)
  return order[(index - 1 + order.length) % order.length] ?? current
}

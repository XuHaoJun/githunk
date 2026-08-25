export const FOCUS_IDS = ["main", "status", "files", "branches", "commits", "stash"] as const
export const COMMAND_LOG_FOCUS_ID = "command-log" as const
export type FocusId = (typeof FOCUS_IDS)[number] | typeof COMMAND_LOG_FOCUS_ID

export function focusIdForKey(key: string): FocusId | undefined {
  const index = Number.parseInt(key, 10)
  return Number.isInteger(index) && index >= 0 && index < FOCUS_IDS.length ? FOCUS_IDS[index] : undefined
}

export type FocusChange = (focus: FocusId, logVisible: boolean) => void

export class FocusManager {
  active: FocusId = "main"
  logVisible = false
  onChange: FocusChange | undefined

  focus(id: FocusId): void {
    if (id === COMMAND_LOG_FOCUS_ID && !this.logVisible) return
    this.active = id
    this.onChange?.(this.active, this.logVisible)
  }

  cycle(direction: "next" | "previous"): void {
    const next = direction === "next"
      ? nextFocus(this.active, this.logVisible)
      : previousFocus(this.active, this.logVisible)
    this.focus(next)
  }

  handleKey(key: string): boolean {
    const numbered = focusIdForKey(key)
    if (numbered !== undefined) {
      this.focus(numbered)
      return true
    }
    if (key !== "@") return false

    if (!this.logVisible) {
      this.logVisible = true
      this.active = "main"
    } else if (this.active === COMMAND_LOG_FOCUS_ID) {
      this.logVisible = false
      this.active = "main"
    } else {
      this.active = COMMAND_LOG_FOCUS_ID
    }
    this.onChange?.(this.active, this.logVisible)
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

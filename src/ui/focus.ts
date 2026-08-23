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

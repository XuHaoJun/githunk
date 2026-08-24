import { normalizeSearchText, removeLastSearchCharacter } from "../app/filter"
import type { KeyLike } from "./keymap"

export type FilterInputState = {
  readonly active: boolean
  readonly query: string
}

export type FilterInputResult = {
  readonly state: FilterInputState
  readonly consumed: boolean
  readonly submitted?: string
  readonly cancelled?: boolean
}

const namedKeys = new Set(["escape", "enter", "backspace", "delete", "tab", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "insert", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"])

/** Pure key transition for a modal search field. */
export function filterInputKey(state: FilterInputState, key: KeyLike): FilterInputResult {
  if (!state.active) return { state, consumed: false }
  if (key.ctrl || key.meta || key.option || key.alt || key.super) return { state, consumed: true }
  if (key.name === "escape") return { state: { active: false, query: state.query }, consumed: true, cancelled: true }
  if (key.name === "enter") return { state: { active: false, query: state.query }, consumed: true, submitted: state.query }
  if (key.name === "backspace" || key.name === "delete") {
    return { state: { active: true, query: removeLastSearchCharacter(state.query) }, consumed: true }
  }
  const payload = key.name === "space"
    ? key.sequence === " " ? key.sequence : " "
    : key.sequence ?? (key.name.length === 1 ? (key.shift ? key.name.toLocaleUpperCase() : key.name) : "")
  if (payload.length > 0 && (key.name === "space" || !namedKeys.has(key.name))) {
    return { state: { active: true, query: `${state.query}${payload}` }, consumed: true }
  }
  return { state, consumed: true }
}

export class FilterInput {
  state: FilterInputState = { active: false, query: "" }

  open(initialQuery = ""): void {
    this.state = { active: true, query: normalizeSearchText(initialQuery) }
  }

  close(): void {
    this.state = { active: false, query: this.state.query }
  }

  clear(): void {
    this.state = { active: this.state.active, query: "" }
  }

  handleKey(key: KeyLike): FilterInputResult {
    const result = filterInputKey(this.state, key)
    this.state = result.state
    return result
  }
}

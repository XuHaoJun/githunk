export type CommitDialogMode = "commit" | "amend"
export type CommitDialogResult =
  | { readonly kind: "confirmed"; readonly message: string }
  | { readonly kind: "cancelled" }

export type CommitDialogState = {
  readonly mode: CommitDialogMode
  readonly message: string
  readonly error?: string
}

export type CommitDialogKey = {
  readonly name: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

export type CommitDialogEvent =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "newline" }
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
export function createCommitDialog(mode: CommitDialogMode, initialMessage = ""): CommitDialogState {
  return { mode, message: initialMessage }
}

export function reduceCommitDialog(state: CommitDialogState, event: CommitDialogEvent): { readonly state: CommitDialogState; readonly result?: CommitDialogResult } {
  if (event.kind === "cancel") return { state, result: { kind: "cancelled" } }
  if (event.kind === "insert") return { state: stateWithoutError({ ...state, message: state.message + event.text }), }
  if (event.kind === "newline") return { state: stateWithoutError({ ...state, message: `${state.message}\n` }), }
  if (event.kind === "backspace") return { state: stateWithoutError({ ...state, message: removeLastGrapheme(state.message) }), }
  if (state.message.trim().length === 0) {
    return { state: { ...state, error: "Commit message cannot be empty" } }
  }
  return { state: stateWithoutError(state), result: { kind: "confirmed", message: state.message } }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function removeLastGrapheme(message: string): string {
  const segments = Array.from(graphemeSegmenter.segment(message), (segment) => segment.segment)
  segments.pop()
  return segments.join("")
}

function stateWithoutError(state: CommitDialogState): CommitDialogState {
  if (state.error === undefined) return state
  const { error: _error, ...withoutError } = state
  return withoutError
}

export function commitDialogKey(state: CommitDialogState, key: CommitDialogKey): { readonly state: CommitDialogState; readonly result?: CommitDialogResult } {
  if (key.name === "escape") return reduceCommitDialog(state, { kind: "cancel" })
  if ((key.name === "enter" || key.name === "return") && key.ctrl === true) return reduceCommitDialog(state, { kind: "confirm" })
  if (key.name === "enter" || key.name === "return") return reduceCommitDialog(state, { kind: "newline" })
  if (key.name === "backspace") return reduceCommitDialog(state, { kind: "backspace" })
  if (key.name === "space" && key.ctrl !== true && key.meta !== true) return reduceCommitDialog(state, { kind: "insert", text: " " })
  const text = printableText(key)
  return text === undefined ? { state } : reduceCommitDialog(state, { kind: "insert", text })
}

function printableText(key: CommitDialogKey): string | undefined {
  if (key.ctrl === true || key.meta === true || key.name.length === 0) return undefined
  if (key.name === "space") return " "
  if (key.name.length === 1) return key.shift === true && /^[a-z]$/.test(key.name) ? key.name.toUpperCase() : key.name
  if (/^\P{Cc}+$/u.test(key.name)) return key.name
  return undefined
}

export function renderCommitDialog(state: CommitDialogState): string {
  const title = state.mode === "amend" ? "Amend commit" : "Commit staged changes"
  const error = state.error === undefined ? "" : `\n! ${state.error}`
  return `${title}\n\n${state.message}\n\nCtrl+Enter confirm · Esc cancel${error}`
}

export class CommitDialog {
  private current: CommitDialogState

  constructor(mode: CommitDialogMode, initialMessage = "") {
    this.current = createCommitDialog(mode, initialMessage)
  }

  get state(): CommitDialogState {
    return this.current
  }

  handle(event: CommitDialogEvent): CommitDialogResult | undefined {
    const next = reduceCommitDialog(this.current, event)
    this.current = next.state
    return next.result
  }

  handleKey(key: CommitDialogKey): CommitDialogResult | undefined {
    const next = commitDialogKey(this.current, key)
    this.current = next.state
    return next.result
  }

  setError(error: string | undefined): void {
    if (error === undefined) {
      this.current = stateWithoutError(this.current)
      return
    }
    this.current = { ...this.current, error }
  }
}

export const createCommitDialogState = createCommitDialog
export const updateCommitDialog = reduceCommitDialog

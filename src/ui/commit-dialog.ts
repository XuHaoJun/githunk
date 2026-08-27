export type CommitDialogMode = "commit" | "amend" | "stash" | "branch-create" | "branch-rename"
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
  readonly sequence?: string
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

export type CommitMessageParts = {
  readonly summary: string
  readonly description: string
}

/** Splits git's subject/body representation the same way lazygit fills its two text areas. */
export function splitCommitMessage(message: string): CommitMessageParts {
  const separator = message.indexOf("\n")
  if (separator < 0) return { summary: message, description: "" }
  const summary = message.slice(0, separator)
  const description = message[separator + 1] === "\n" ? message.slice(separator + 2) : message.slice(separator + 1)
  return { summary, description }
}

/** Joins the two lazygit-style fields into the message passed to `git commit -F -`. */
export function joinCommitMessage(summary: string, description: string): string {
  return description.length === 0 ? summary : `${summary}\n\n${description}`
}


export function reduceCommitDialog(state: CommitDialogState, event: CommitDialogEvent): { readonly state: CommitDialogState; readonly result?: CommitDialogResult } {
  if (event.kind === "cancel") return { state, result: { kind: "cancelled" } }
  if (event.kind === "insert") return { state: stateWithoutError({ ...state, message: state.message + event.text }), }
  if (event.kind === "newline") return { state: stateWithoutError({ ...state, message: `${state.message}\n` }), }
  if (event.kind === "backspace") return { state: stateWithoutError({ ...state, message: removeLastGrapheme(state.message) }), }
  if (state.message.trim().length === 0) {
    return { state: { ...state, error: `${state.mode === "branch-create" || state.mode === "branch-rename" ? "Branch name" : state.mode === "stash" ? "Stash message" : "Commit message"} cannot be empty` } }
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
  if (key.name === "enter" && key.ctrl === true) return reduceCommitDialog(state, { kind: "confirm" })
  if (key.name === "enter") return reduceCommitDialog(state, { kind: "newline" })
  if (key.name === "backspace") return reduceCommitDialog(state, { kind: "backspace" })
  if (key.name === "space" && key.ctrl !== true && key.meta !== true) return reduceCommitDialog(state, { kind: "insert", text: " " })
  const text = printableText(key)
  return text === undefined ? { state } : reduceCommitDialog(state, { kind: "insert", text })
}

const NON_PRINTABLE_KEY_NAMES: Record<string, true> = {
  // `key.name === "enter"` above already covers the normalized case (see keymap.ts's
  // return -> enter alias), so this dialog never sees a raw "return" today. Kept here as
  // defense in depth in case an un-normalized key event ever reaches this function directly.
  tab: true, linefeed: true, left: true, right: true, up: true, down: true, home: true, end: true, insert: true, delete: true,
  pageup: true, pagedown: true, "page-up": true, "page-down": true, escape: true, enter: true, return: true, backspace: true,
  clear: true, shift: true, ctrl: true, alt: true, meta: true, capslock: true, numlock: true, printscreen: true, pause: true, menu: true,
  scrolllock: true, media: true, play: true, pausemedia: true, volumeup: true, volumedown: true, volumemute: true,
}

function isNamedControl(name: string): boolean {
  return NON_PRINTABLE_KEY_NAMES[name] === true
    || /^f\d+$/u.test(name)
    || /^kp(?:enter|page(?:up|down)|left|right|up|down|home|end|insert|delete)$/u.test(name)
    || /^(?:media|volume|scroll)/u.test(name)
}

function printableText(key: CommitDialogKey): string | undefined {
  if (key.ctrl === true || key.meta === true || key.name.length === 0 || isNamedControl(key.name)) return undefined
  if (key.name === "space") return " "
  const candidate = key.sequence ?? (key.shift === true && /^[a-z]$/u.test(key.name) ? key.name.toUpperCase() : key.name)
  if (candidate.length === 0 || /[\u0000-\u001F\u007F\u001B]/u.test(candidate)) return undefined
  const graphemes = Array.from(graphemeSegmenter.segment(candidate))
  if (graphemes.length === 1 && /^\P{Cc}+$/u.test(candidate)) return candidate
  return undefined
}

export function renderCommitDialog(state: CommitDialogState): string {
  const title = state.mode === "amend" ? "Amend commit"
    : state.mode === "stash" ? "Create stash"
      : state.mode === "branch-create" ? "Create branch"
        : state.mode === "branch-rename" ? "Rename branch"
          : "Commit staged changes"
  const error = state.error === undefined ? "" : `\n! ${state.error}`
  if (state.mode === "commit" || state.mode === "amend") {
    const parts = splitCommitMessage(state.message)
    return `${title}\n\nCommit summary\n${parts.summary}\n\nCommit description\n${parts.description}\n\nEnter submit · Tab description · Esc cancel${error}`
  }
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

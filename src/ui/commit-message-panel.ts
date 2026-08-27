import { BoxRenderable, RGBA, TextRenderable, TextareaRenderable, type CliRenderer, type KeyEvent } from "@opentui/core"
import { joinCommitMessage, splitCommitMessage } from "./commit-dialog"
import { TAB_ACTIVE_FG } from "./theme"

export type CommitMessagePanelMode = "commit" | "amend"
export type CommitMessageField = "summary" | "description"

export type CommitMessagePanelState = {
  readonly mode: CommitMessagePanelMode
  readonly field: CommitMessageField
  readonly summary: string
  readonly description: string
  readonly error?: string
}

export type CommitMessagePanelResult =
  | { readonly kind: "confirmed"; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "changed" }

export type CommitMessagePanelLayout = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly summary: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
  readonly description: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
}

/**
 * lazygit leaves popup views at gocui's `ColorDefault` background/foreground instead of
 * choosing an RGB black. OpenTUI's RGBA intent preserves that terminal-resolved colour, so a
 * grey terminal stays grey (`pkg/gocui/gui.go:294-295`, `pkg/gui/views.go:121-127`).
 */
const POPUP_BACKGROUND = RGBA.defaultBackground()
const POPUP_FOREGROUND = RGBA.defaultForeground()
const FIELD_BORDER = POPUP_FOREGROUND
const FIELD_ACTIVE_BORDER = TAB_ACTIVE_FG
/**
 * lazygit only enables the terminal cursor for editable views; it does not emit a cursor-shape
 * override (`pkg/gui/context.go:199`). Its normal terminal cursor is therefore OpenTUI's block
 * cursor, not the previous custom cyan line.
 */
const POPUP_CURSOR_STYLE = { style: "block" as const, blinking: true }
const POPUP_Z_INDEX = 100
const SUMMARY_HEIGHT = 3
const DESCRIPTION_TOP = 3
const MIN_DESCRIPTION_HEIGHT = 7

type CommitMessageKey = Pick<KeyEvent, "name" | "ctrl" | "meta" | "option" | "super" | "hyper">

function hasModifier(key: CommitMessageKey): boolean {
  return key.ctrl === true || key.meta === true || key.option === true || key.super === true || key.hyper === true
}

function hasCtrlOnly(key: CommitMessageKey): boolean {
  return key.ctrl === true && key.meta !== true && key.option !== true && key.super !== true && key.hyper !== true
}

function controlsFor(field: CommitMessageField): string {
  return field === "summary"
    ? "Enter submit · Tab description · Esc cancel"
    : "Ctrl+Enter submit · Tab summary · Esc cancel"
}

function footerFor(field: CommitMessageField, error: string | undefined): string {
  const controls = controlsFor(field)
  return error === undefined ? controls : `! ${error} · ${controls}`
}

export function createCommitMessagePanelState(mode: CommitMessagePanelMode, initialMessage = ""): CommitMessagePanelState {
  const parts = splitCommitMessage(initialMessage)
  return {
    mode,
    field: "summary",
    summary: parts.summary,
    description: parts.description,
  }
}

export function commitMessagePanelLayout(
  terminalWidth: number,
  terminalHeight: number,
  descriptionLines: number,
): CommitMessagePanelLayout {
  const width = Math.max(1, Math.floor(terminalWidth))
  const height = Math.max(1, Math.floor(terminalHeight))
  const availableWidth = Math.max(1, width - 2)
  const ratioWidth = Math.floor((width * 4) / 7)
  const requestedWidth = ratioWidth < 80 ? 80 : Math.min(ratioWidth, 100)
  const popupWidth = Math.min(availableWidth, Math.max(20, requestedWidth))
  const desiredDescriptionHeight = Math.max(MIN_DESCRIPTION_HEIGHT, Math.max(1, Math.floor(descriptionLines)) + 4)
  const desiredHeight = DESCRIPTION_TOP + desiredDescriptionHeight
  const popupHeight = Math.min(height, Math.max(1, desiredHeight))
  const summaryHeight = Math.min(SUMMARY_HEIGHT, popupHeight)
  const descriptionTop = summaryHeight
  const descriptionHeight = Math.max(1, popupHeight - descriptionTop)

  return {
    left: Math.max(0, Math.floor((width - popupWidth) / 2)),
    top: Math.max(0, Math.floor((height - popupHeight) / 2)),
    width: popupWidth,
    height: popupHeight,
    summary: {
      left: 0,
      top: 0,
      width: popupWidth,
      height: summaryHeight,
    },
    description: {
      left: 0,
      top: descriptionTop,
      width: popupWidth,
      height: descriptionHeight,
    },
  }
}

export function commitMessagePanelKey(field: CommitMessageField, key: CommitMessageKey): "cancel" | "confirm" | "switch" | undefined {
  if (key.name === "escape") return "cancel"
  if (key.name === "tab" && !hasModifier(key)) return "switch"
  if (key.name !== "enter") return undefined
  if (field === "summary" && (!hasModifier(key) || hasCtrlOnly(key))) return "confirm"
  if (field === "description" && hasCtrlOnly(key)) return "confirm"
  return undefined
}

export type CommitMessagePanelHandle = {
  readonly box: BoxRenderable
  readonly summary: TextareaRenderable
  readonly description: TextareaRenderable
  readonly visible: boolean
  readonly mode: CommitMessagePanelMode | undefined
  readonly state: CommitMessagePanelState | undefined
  open(mode: CommitMessagePanelMode, initialMessage?: string): void
  close(): void
  setError(error: string | undefined): void
  handleKey(key: KeyEvent): CommitMessagePanelResult | undefined
  layout(terminalWidth: number, terminalHeight: number): void
}

export function createCommitMessagePanel(renderer: CliRenderer): CommitMessagePanelHandle {
  const box = new BoxRenderable(renderer, {
    id: "commit-message-popup",
    position: "absolute",
    border: false,
    backgroundColor: POPUP_BACKGROUND,
    shouldFill: true,
    overflow: "hidden",
    zIndex: POPUP_Z_INDEX,
    visible: false,
  })
  const summaryBox = new BoxRenderable(renderer, {
    id: "commit-summary-box",
    position: "absolute",
    border: true,
    borderColor: FIELD_BORDER,
    backgroundColor: POPUP_BACKGROUND,
    title: "Commit summary",
    overflow: "hidden",
  })
  const descriptionBox = new BoxRenderable(renderer, {
    id: "commit-description-box",
    position: "absolute",
    border: true,
    borderColor: FIELD_BORDER,
    backgroundColor: POPUP_BACKGROUND,
    title: "Commit description",
    overflow: "hidden",
  })
  const summary = new TextareaRenderable(renderer, {
    id: "commit-summary-editor",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    selectable: true,
    wrapMode: "none",
    showCursor: true,
    textColor: POPUP_FOREGROUND,
    focusedTextColor: POPUP_FOREGROUND,
    backgroundColor: POPUP_BACKGROUND,
    focusedBackgroundColor: POPUP_BACKGROUND,
    selectionBg: "#444444",
    selectionFg: POPUP_FOREGROUND,
    cursorColor: POPUP_FOREGROUND,
    cursorStyle: POPUP_CURSOR_STYLE,
  })
  const description = new TextareaRenderable(renderer, {
    id: "commit-description-editor",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    selectable: true,
    wrapMode: "word",
    showCursor: true,
    textColor: POPUP_FOREGROUND,
    focusedTextColor: POPUP_FOREGROUND,
    backgroundColor: POPUP_BACKGROUND,
    focusedBackgroundColor: POPUP_BACKGROUND,
    selectionBg: "#444444",
    selectionFg: POPUP_FOREGROUND,
    cursorColor: POPUP_FOREGROUND,
    cursorStyle: POPUP_CURSOR_STYLE,
  })
  const descriptionHint = new TextRenderable(renderer, {
    id: "commit-description-hint",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    content: "",
    fg: POPUP_FOREGROUND,
    bg: POPUP_BACKGROUND,
    selectable: false,
    wrapMode: "none",
    zIndex: 2,
  })
  summary.focusable = true
  description.focusable = true
  summaryBox.add(summary)
  descriptionBox.add(description)
  box.add(summaryBox)
  box.add(descriptionBox)
  box.add(descriptionHint)

  let current: CommitMessagePanelState | undefined

  const updateFooter = (): void => {
    if (current === undefined) {
      descriptionHint.content = ""
      descriptionBox.bottomTitle = undefined
      return
    }
    descriptionHint.content = footerFor(current.field, undefined)
    descriptionBox.bottomTitle = current.error === undefined ? undefined : `! ${current.error}`
  }

  const updateFieldFocus = (): void => {
    if (current === undefined) return
    const summaryActive = current.field === "summary"
    if (summaryActive) {
      description.blur()
      summary.focus()
    } else {
      summary.blur()
      description.focus()
    }
    summaryBox.borderColor = summaryActive ? FIELD_ACTIVE_BORDER : FIELD_BORDER
    descriptionBox.borderColor = summaryActive ? FIELD_BORDER : FIELD_ACTIVE_BORDER
  }

  const switchField = (): void => {
    if (current === undefined) return
    const { error: _error, ...withoutError } = current
    current = {
      ...withoutError,
      field: current.field === "summary" ? "description" : "summary",
    }
    updateFieldFocus()
    updateFooter()
  }

  const confirm = (): CommitMessagePanelResult | undefined => {
    if (current === undefined) return undefined
    const summaryText = summary.plainText
    const descriptionText = description.plainText
    if (summaryText.trim().length === 0) {
      current = {
        ...current,
        summary: summaryText,
        description: descriptionText,
        error: "Commit message cannot be empty",
      }
      updateFooter()
      return undefined
    }
    const { error: _error, ...withoutError } = current
    current = {
      ...withoutError,
      summary: summaryText,
      description: descriptionText,
    }
    updateFooter()
    return { kind: "confirmed", message: joinCommitMessage(summaryText, descriptionText) }
  }

  return {
    box,
    summary,
    description,
    get visible(): boolean {
      return box.visible
    },
    get mode(): CommitMessagePanelMode | undefined {
      return current?.mode
    },
    get state(): CommitMessagePanelState | undefined {
      if (current === undefined) return undefined
      return {
        ...current,
        summary: summary.plainText,
        description: description.plainText,
      }
    },
    open(mode, initialMessage = "") {
      current = createCommitMessagePanelState(mode, initialMessage)
      summary.setText(current.summary)
      description.setText(current.description)
      summary.gotoBufferEnd()
      description.gotoBufferEnd()
      box.title = undefined
      summaryBox.title = mode === "amend" ? "Amend commit" : "Commit summary"
      descriptionBox.title = "Commit description"
      box.visible = true
      updateFieldFocus()
      updateFooter()
    },
    close() {
      summary.blur()
      description.blur()
      box.visible = false
      current = undefined
      descriptionHint.content = ""
      descriptionBox.bottomTitle = undefined
    },
    setError(error) {
      if (current === undefined) return
      current = error === undefined
        ? { mode: current.mode, field: current.field, summary: summary.plainText, description: description.plainText }
        : { mode: current.mode, field: current.field, summary: summary.plainText, description: description.plainText, error }
      updateFooter()
    },
    handleKey(key) {
      if (current === undefined) return undefined
      const action = commitMessagePanelKey(current.field, key)
      if (action === "cancel") return { kind: "cancelled" }
      if (action === "switch") {
        switchField()
        box.requestRender()
        return { kind: "changed" }
      }
      if (action === "confirm") return confirm()

      const editor = current.field === "summary" ? summary : description
      const handled = editor.handleKeyPress(key)
      if (!handled) return undefined
      if (current.error !== undefined) {
        const { error: _error, ...withoutError } = current
        current = {
          ...withoutError,
          summary: summary.plainText,
          description: description.plainText,
        }
        updateFooter()
      }
      box.requestRender()
      return { kind: "changed" }
    },
    layout(terminalWidth, terminalHeight) {
      const descriptionLines = Math.max(1, description.plainText.split("\n").length)
      const geometry = commitMessagePanelLayout(terminalWidth, terminalHeight, descriptionLines)
      box.left = geometry.left
      box.top = geometry.top
      box.width = geometry.width
      box.height = geometry.height
      summaryBox.left = geometry.summary.left
      summaryBox.top = geometry.summary.top
      summaryBox.width = geometry.summary.width
      summaryBox.height = geometry.summary.height
      descriptionBox.left = geometry.description.left
      descriptionBox.top = geometry.description.top
      descriptionBox.width = geometry.description.width
      descriptionBox.height = geometry.description.height
      summary.left = 0
      summary.top = 0
      summary.width = Math.max(1, geometry.summary.width - 2)
      summary.height = Math.max(1, geometry.summary.height - 2)
      description.left = 0
      description.top = 0
      description.width = Math.max(1, geometry.description.width - 2)
      description.height = Math.max(1, geometry.description.height - 2)
      const hint = current === undefined ? "" : footerFor(current.field, undefined)
      descriptionHint.top = geometry.description.top
      descriptionHint.left = Math.max(0, geometry.description.width - hint.length - 1)
      descriptionHint.width = Math.max(1, Math.min(geometry.description.width, hint.length))
      descriptionHint.height = 1
    },
  }
}

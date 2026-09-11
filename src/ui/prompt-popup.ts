import { BoxRenderable, InputRenderable, RGBA, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core"
import { TAB_ACTIVE_FG } from "./theme"
import { popupPanelWidth, popupPanelGeometry, wrapMessage } from "./popup-layout"
import type { CommitDialogState } from "./commit-dialog"

const POPUP_BACKGROUND = RGBA.defaultBackground()
const POPUP_FOREGROUND = RGBA.defaultForeground()
/**
 * lazygit enables the terminal cursor for its editable prompt view
 * (`pkg/gui/context.go:172-200`, `pkg/gui/views.go:133-136`). Keep the
 * normal OpenTUI block cursor instead of rendering a prompt as plain text.
 */
const POPUP_CURSOR_STYLE = { style: "block" as const, blinking: true }
const POPUP_Z_INDEX = 100

function titleFor(state: CommitDialogState): string {
  if (state.mode === "branch-create") {
    return state.branchBase === undefined ? "Create branch" : `New branch name (branch is off of '${state.branchBase}')`
  }
  if (state.mode === "branch-rename") return "Rename branch"
  if (state.mode === "stash") return "Create stash"
  if (state.mode === "amend") return "Amend commit"
  return "Commit staged changes"
}

function footerFor(state: CommitDialogState, extraLine?: string): string {
  const error = state.error === undefined ? "" : `\n! ${state.error}`
  const base = `\n\nEnter confirm · Esc cancel${error}`
  return extraLine === undefined ? base : `${base}\n${extraLine}`
}

export type PromptPopupHandle = {
  readonly box: BoxRenderable
  readonly input: InputRenderable
  readonly visible: boolean
  open(state: CommitDialogState, extraLine?: string): void
  update(state: CommitDialogState, extraLine?: string): void
  handleKey(key: KeyEvent): boolean
  close(): void
  layout(terminalWidth: number, terminalHeight: number): void
}

export function createPromptPopup(renderer: CliRenderer): PromptPopupHandle {
  const box = new BoxRenderable(renderer, {
    id: "prompt-popup",
    border: true,
    borderStyle: "rounded",
    borderColor: TAB_ACTIVE_FG,
    focusedBorderColor: TAB_ACTIVE_FG,
    titleColor: TAB_ACTIVE_FG,
    title: "",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: POPUP_BACKGROUND,
    zIndex: POPUP_Z_INDEX,
  })
  const footer = new TextRenderable(renderer, {
    id: "prompt-popup-footer",
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
  })
  const input = new InputRenderable(renderer, {
    id: "prompt-popup-input",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    selectable: true,
    wrapMode: "none",
    maxLength: Number.MAX_SAFE_INTEGER,
    textColor: POPUP_FOREGROUND,
    focusedTextColor: POPUP_FOREGROUND,
    backgroundColor: POPUP_BACKGROUND,
    focusedBackgroundColor: POPUP_BACKGROUND,
    selectionBg: "#444444",
    selectionFg: POPUP_FOREGROUND,
    cursorColor: POPUP_FOREGROUND,
    cursorStyle: POPUP_CURSOR_STYLE,
    zIndex: 1,
  })
  input.height = 1
  input.focusable = true
  box.add(footer)
  box.add(input)
  box.visible = false

  let current: CommitDialogState | undefined
  let extra: string | undefined
  let contentWidth = 40

  const wrappedFooter = (): string[] => {
    if (current === undefined) return []
    const raw = footerFor(current, extra)
    const logicalLines = raw.split("\n")
    const wrapped: string[] = []
    for (const line of logicalLines) {
      if (line.length === 0) {
        wrapped.push("")
        continue
      }
      wrapped.push(...wrapMessage(line, contentWidth))
    }
    return wrapped
  }

  const paint = (): void => {
    footer.content = wrappedFooter().join("\n")
  }

  return {
    box,
    input,
    get visible(): boolean {
      return box.visible
    },
    open(state, extraLine) {
      current = state
      extra = extraLine
      box.title = titleFor(state)
      input.value = state.message
      input.gotoBufferEnd()
      box.visible = true
      paint()
      input.focus()
    },
    update(state, extraLine) {
      current = state
      if (extraLine !== undefined) extra = extraLine
      box.title = titleFor(state)
      if (input.value !== state.message) {
        input.value = state.message
        input.gotoBufferEnd()
      }
      paint()
    },
    handleKey(key) {
      if (current === undefined) return false
      const handled = input.handleKeyPress(key)
      if (handled) {
        paint()
        box.requestRender()
      }
      return handled
    },
    close() {
      input.blur()
      current = undefined
      extra = undefined
      box.visible = false
      input.value = ""
      footer.content = ""
      box.title = ""
    },
    layout(terminalWidth, terminalHeight) {
      if (current === undefined || !box.visible) {
        box.visible = false
        return
      }
      const panelWidth = popupPanelWidth(terminalWidth, 80)
      const nextContentWidth = Math.max(1, panelWidth - 2)
      contentWidth = nextContentWidth
      const lines = wrappedFooter()
      const contentHeight = Math.max(1, lines.length)
      const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
      box.left = geom.left
      box.top = geom.top
      box.width = geom.width
      box.height = geom.height
      input.left = 0
      input.top = 0
      input.width = contentWidth
      input.height = 1
      footer.left = 0
      footer.top = 0
      footer.width = contentWidth
      footer.height = contentHeight
      box.visible = true
      paint()
    },
  }
}

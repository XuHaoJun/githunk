import { BoxRenderable, RGBA, TextRenderable, type CliRenderer } from "@opentui/core"
import { TAB_ACTIVE_FG } from "./theme"
import { popupPanelWidth, popupPanelGeometry, wrapMessage } from "./popup-layout"
import type { CommitDialogState } from "./commit-dialog"

const POPUP_BACKGROUND = RGBA.defaultBackground()
const POPUP_FOREGROUND = RGBA.defaultForeground()
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

function bodyFor(state: CommitDialogState, extraLine?: string): string {
  const error = state.error === undefined ? "" : `\n! ${state.error}`
  const base = `${state.message}\n\nCtrl+Enter confirm · Esc cancel${error}`
  return extraLine === undefined ? base : `${base}\n${extraLine}`
}

export type PromptPopupHandle = {
  readonly box: BoxRenderable
  readonly visible: boolean
  open(state: CommitDialogState, extraLine?: string): void
  update(state: CommitDialogState, extraLine?: string): void
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
    titleColor: POPUP_FOREGROUND,
    title: "",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: POPUP_BACKGROUND,
    zIndex: POPUP_Z_INDEX,
  })
  const text = new TextRenderable(renderer, {
    id: "prompt-popup-text",
    content: "",
    fg: POPUP_FOREGROUND,
    bg: POPUP_BACKGROUND,
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  box.visible = false

  let current: CommitDialogState | undefined
  let extra: string | undefined
  let contentWidth = 40

  const paint = (): void => {
    if (current === undefined) {
      text.content = ""
      return
    }
    const raw = bodyFor(current, extra)
    // Wrap the message line (first line of body) to contentWidth, but keep
    // the hint/error lines as separate. For simplicity, wrap the whole body
    // per logical line.
    const logicalLines = raw.split("\n")
    const wrapped: string[] = []
    for (const line of logicalLines) {
      if (line.length === 0) {
        wrapped.push("")
        continue
      }
      // Only the branch/stash name line (state.message) may be long and needs
      // wrapping; other lines are short hints/errors. Wrapping all is safe.
      const pieces = wrapMessage(line, contentWidth)
      wrapped.push(...pieces)
    }
    text.content = wrapped.join("\n")
  }

  return {
    box,
    get visible(): boolean {
      return box.visible
    },
    open(state, extraLine) {
      current = state
      extra = extraLine
      box.title = titleFor(state)
      box.visible = true
      paint()
    },
    update(state, extraLine) {
      current = state
      if (extraLine !== undefined) extra = extraLine
      box.title = titleFor(state)
      paint()
    },
    close() {
      current = undefined
      extra = undefined
      box.visible = false
      text.content = ""
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
      const raw = bodyFor(current, extra)
      // Height is number of wrapped visual lines + 2 for frame, capped via popupPanelGeometry
      const wrappedLines = raw.split("\n").flatMap((line) => (line.length === 0 ? [""] : wrapMessage(line, contentWidth)))
      const contentHeight = wrappedLines.length
      const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
      box.left = geom.left
      box.top = geom.top
      box.width = geom.width
      box.height = geom.height
      box.visible = true
      paint()
    },
  }
}

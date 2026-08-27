import { BoxRenderable, RGBA, TextRenderable, type CliRenderer } from "@opentui/core"
import { TAB_ACTIVE_FG } from "./theme"
import { popupPanelWidth, popupPanelGeometry, wrapMessage } from "./popup-layout"

const POPUP_BACKGROUND = RGBA.defaultBackground()
const POPUP_FOREGROUND = RGBA.defaultForeground()
const POPUP_Z_INDEX = 100

export type InfoPopupHandle = {
  readonly box: BoxRenderable
  readonly visible: boolean
  show(title: string, message: string): void
  hide(): void
  layout(terminalWidth: number, terminalHeight: number): void
}

export function createInfoPopup(renderer: CliRenderer, id = "info-popup"): InfoPopupHandle {
  const box = new BoxRenderable(renderer, {
    id,
    border: true,
    borderStyle: "rounded",
    borderColor: POPUP_FOREGROUND,
    focusedBorderColor: TAB_ACTIVE_FG,
    titleColor: POPUP_FOREGROUND,
    title: "",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: POPUP_BACKGROUND,
    zIndex: POPUP_Z_INDEX,
  })
  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
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

  let currentTitle = ""
  let currentMessage = ""
  let contentWidth = 40

  const paint = (): void => {
    const wrapped = wrapMessage(currentMessage, contentWidth)
    text.content = wrapped.join("\n")
  }

  return {
    box,
    get visible(): boolean {
      return box.visible
    },
    show(title, message) {
      currentTitle = title
      currentMessage = message
      box.title = title
      box.visible = true
      paint()
    },
    hide() {
      currentTitle = ""
      currentMessage = ""
      box.title = ""
      box.visible = false
      text.content = ""
    },
    layout(terminalWidth, terminalHeight) {
      if (!box.visible) return
      const panelWidth = popupPanelWidth(terminalWidth, 80)
      const nextContentWidth = Math.max(1, panelWidth - 2)
      contentWidth = nextContentWidth
      const wrapped = wrapMessage(currentMessage, contentWidth)
      const contentHeight = wrapped.length
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

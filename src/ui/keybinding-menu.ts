import { BoxRenderable, RGBA, TextRenderable, type CliRenderer } from "@opentui/core"
import { TAB_ACTIVE_FG } from "./theme"
import type { MenuEntry } from "./bindings"
import { popupPanelWidth, popupPanelGeometry } from "./popup-layout"
const UNAVAILABLE_SUFFIX = "  (unavailable)"

export function renderMenuLines(entries: readonly MenuEntry[], contextTitle: string): readonly string[] {
  const keyWidth = entries.reduce((widest, entry) => Math.max(widest, entry.keys.length), 0)
  const lines: string[] = []
  let group: MenuEntry["group"] | undefined
  for (const entry of entries) {
    if (entry.group !== group) {
      group = entry.group
      lines.push(group === "context" ? contextTitle : "Global")
    }
    const keys = entry.keys.padEnd(keyWidth, " ")
    lines.push(`  ${keys}  ${entry.description}${entry.enabled ? "" : UNAVAILABLE_SUFFIX}`)
  }
  return lines
}

export type KeybindingMenuHandle = {
  readonly box: BoxRenderable
  update(entries: readonly MenuEntry[], contextTitle: string): void
  layout(terminalWidth: number, terminalHeight: number): void
}
export function createKeybindingMenu(renderer: CliRenderer): KeybindingMenuHandle {
  const POPUP_BACKGROUND = RGBA.defaultBackground()
  const POPUP_FOREGROUND = RGBA.defaultForeground()
  const POPUP_Z_INDEX = 100
  const box = new BoxRenderable(renderer, {
    id: "keybinding-menu",
    border: true,
    borderStyle: "rounded",
    borderColor: TAB_ACTIVE_FG,
    focusedBorderColor: TAB_ACTIVE_FG,
    titleColor: POPUP_FOREGROUND,
    title: "Keybindings",
    bottomTitle: "Escape or ? to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: POPUP_BACKGROUND,
    zIndex: POPUP_Z_INDEX,
  })
  const text = new TextRenderable(renderer, {
    id: "keybinding-menu-text",
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
  let lastEntries: readonly MenuEntry[] = []
  let lastTitle = ""
  return {
    box,
    update(entries: readonly MenuEntry[], contextTitle: string) {
      lastEntries = entries
      lastTitle = contextTitle
      text.content = renderMenuLines(entries, contextTitle).join("\n")
    },
    layout(terminalWidth: number, terminalHeight: number) {
      // Lazygit's menu uses max 90 and centers on screen; githunk's keybinding
      // menu is a read-only menu so it follows the same sizing as any other
      // menu popup. The content height is the number of rendered lines.
      const lines = renderMenuLines(lastEntries, lastTitle)
      const maxWidth = 90
      const panelWidth = popupPanelWidth(terminalWidth, maxWidth)
      const contentWidth = Math.max(1, panelWidth - 2)
      const contentHeight = lines.length
      const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
      box.left = geom.left
      box.top = geom.top
      box.width = geom.width
      box.height = geom.height
      box.visible = true
    },
  }
}

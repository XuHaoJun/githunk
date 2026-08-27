import { BoxRenderable, RGBA, TextRenderable, type CliRenderer } from "@opentui/core"
import { TAB_ACTIVE_FG } from "./theme"
import { popupPanelWidth, popupPanelGeometry, wrapMessage } from "./popup-layout"
/**
 * A titled, keyed, actionable menu — lazygit's `types.CreateMenuOptions` / `types.MenuItem`
 * (pkg/gui/extras_panel.go:12-38 builds the command log's). githunk already had a *read-only*
 * keybinding menu (./keybinding-menu.ts); this is the one whose items do something.
 *
 * Each item carries its own accelerator, as lazygit's `MenuItem.Keys` does, so `t` and `f` work
 * without moving a cursor first. `j`/`k` plus `enter` work too, and `escape` dismisses.
 */

export type ActionMenuItem = {
  /** The item's own accelerator, e.g. `"t"`. lazygit's `MenuItem.Keys`. */
  readonly key: string
  readonly label: string
  readonly onPress: () => void
  /** A disabled item remains visible, like lazygit's disabled menu rows. */
  readonly disabledReason?: string
  /** Optional side effect when a user chooses a disabled item. */
  readonly onDisabled?: () => void
}

function actionMenuLabel(item: ActionMenuItem): string {
  return item.disabledReason === undefined ? item.label : `${item.label} (unavailable: ${item.disabledReason})`
}

export function renderActionMenuLines(items: readonly ActionMenuItem[], selectedIndex: number): readonly string[] {
  const keyWidth = items.reduce((widest, item) => Math.max(widest, item.key.length), 0)
  return items.map((item, index) =>
    `${index === selectedIndex ? ">" : " "} ${item.key.padEnd(keyWidth, " ")}  ${actionMenuLabel(item)}`,
  )
}

export type ActionMenuHandle = {
  readonly box: BoxRenderable
  isOpen(): boolean
  openMenu(title: string, items: readonly ActionMenuItem[], prompt?: string): void
  close(): void
  /** Returns true when the key was consumed, so the caller stops dispatching it. */
  handleKey(name: string): boolean
  layout(terminalWidth: number, terminalHeight: number): void
}

export function createActionMenu(renderer: CliRenderer): ActionMenuHandle {
  const POPUP_BACKGROUND = RGBA.defaultBackground()
  const POPUP_FOREGROUND = RGBA.defaultForeground()
  const POPUP_Z_INDEX = 100
  const box = new BoxRenderable(renderer, {
    id: "action-menu",
    border: true,
    borderStyle: "rounded",
    borderColor: TAB_ACTIVE_FG,
    focusedBorderColor: TAB_ACTIVE_FG,
    titleColor: POPUP_FOREGROUND,
    title: "",
    bottomTitle: "Escape to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: POPUP_BACKGROUND,
    zIndex: POPUP_Z_INDEX,
  })
  const text = new TextRenderable(renderer, {
    id: "action-menu-text",
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

  let items: readonly ActionMenuItem[] = []
  let prompt = ""
  let selectedIndex = 0
  let open = false
  let contentWidth = 40

  const paint = (): void => {
    const wrapped = prompt.length === 0 ? [] : wrapMessage(prompt, contentWidth)
    const promptSection = wrapped.length === 0 ? [] : [...wrapped, ""]
    text.content = [...promptSection, ...renderActionMenuLines(items, selectedIndex)].join("\n")
  }

  return {
    box,
    isOpen: () => open,
    openMenu(title: string, nextItems: readonly ActionMenuItem[], nextPrompt = "") {
      open = true
      items = nextItems
      prompt = nextPrompt
      selectedIndex = 0
      box.title = title
      box.visible = true
      paint()
    },
    close() {
      open = false
      items = []
      prompt = ""
      selectedIndex = 0
      box.visible = false
      text.content = ""
    },
    handleKey(name: string): boolean {
      if (!open) return false
      if (name === "escape") {
        this.close()
        return true
      }
      if (name === "j" || name === "down") {
        selectedIndex = items.length === 0 ? 0 : (selectedIndex + 1) % items.length
        paint()
        return true
      }
      if (name === "k" || name === "up") {
        selectedIndex = items.length === 0 ? 0 : (selectedIndex - 1 + items.length) % items.length
        paint()
        return true
      }
      // An item's own key fires it wherever the cursor is, as lazygit's MenuItem.Keys do.
      const pressed = name === "return" || name === "enter"
        ? items[selectedIndex]
        : items.find((item) => item.key === name)
      if (pressed === undefined) return false
      if (pressed.disabledReason !== undefined) {
        pressed.onDisabled?.()
        return true
      }
      // Closed before the handler runs: an item may itself open a panel or move focus, and it must
      // not have to fight a menu that is still up — exactly what lazygit's command-log toggle does
      // (extras_panel.go:19-29 pops the context first).
      this.close()
      pressed.onPress()
      return true
    },
    layout(terminalWidth: number, terminalHeight: number) {
      if (!open) {
        box.visible = false
        return
      }
      // Lazygit's confirmation vs menu max widths: 80 for confirmation-like
      // (prompt + few items) and 90 for generic menus. Use 80 when the menu
      // carries a prompt (the confirmation path) to match
      // `resizeConfirmationPanel`'s `getPopupPanelWidth(80)`, otherwise 90 to
      // match `resizeMenu`'s 90.
      const maxWidth = prompt.length > 0 ? 80 : 90
      const panelWidth = popupPanelWidth(terminalWidth, maxWidth)
      const nextContentWidth = Math.max(1, panelWidth - 2)
      contentWidth = nextContentWidth
      const wrapped = prompt.length === 0 ? [] : wrapMessage(prompt, contentWidth)
      const promptLinesCount = wrapped.length === 0 ? 0 : wrapped.length + 1
      const contentHeight = promptLinesCount + items.length
      const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
      box.left = geom.left
      box.top = geom.top
      box.width = geom.width
      box.height = geom.height
      box.visible = true
      // Re-render with the width-correct wrapped prompt
      paint()
    },
  }
}

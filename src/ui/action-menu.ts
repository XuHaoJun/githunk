import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dimensions } from "./boxlayout"
import { DEFAULT_BACKGROUND, DEFAULT_FOREGROUND } from "./theme"

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
}

export function renderActionMenuLines(items: readonly ActionMenuItem[], selectedIndex: number): readonly string[] {
  const keyWidth = items.reduce((widest, item) => Math.max(widest, item.key.length), 0)
  return items.map((item, index) =>
    `${index === selectedIndex ? ">" : " "} ${item.key.padEnd(keyWidth, " ")}  ${item.label}`,
  )
}

export type ActionMenuHandle = {
  readonly box: BoxRenderable
  isOpen(): boolean
  openMenu(title: string, items: readonly ActionMenuItem[]): void
  close(): void
  /** Returns true when the key was consumed, so the caller stops dispatching it. */
  handleKey(name: string): boolean
  layout(host: Dimensions, terminalHeight: number): void
}

export function createActionMenu(renderer: CliRenderer): ActionMenuHandle {
  const box = new BoxRenderable(renderer, {
    id: "action-menu",
    border: true,
    borderColor: DEFAULT_FOREGROUND,
    focusedBorderColor: DEFAULT_FOREGROUND,
    titleColor: DEFAULT_FOREGROUND,
    title: "",
    bottomTitle: "Escape to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: DEFAULT_BACKGROUND,
  })
  const text = new TextRenderable(renderer, {
    id: "action-menu-text",
    content: "",
    fg: DEFAULT_FOREGROUND,
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  box.visible = false

  let items: readonly ActionMenuItem[] = []
  let selectedIndex = 0
  let open = false

  const paint = (): void => {
    text.content = renderActionMenuLines(items, selectedIndex).join("\n")
  }

  return {
    box,
    isOpen: () => open,
    openMenu(title: string, nextItems: readonly ActionMenuItem[]) {
      open = true
      items = nextItems
      selectedIndex = 0
      box.title = title
      box.visible = true
      paint()
    },
    close() {
      open = false
      items = []
      selectedIndex = 0
      box.visible = false
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
      // Closed before the handler runs: an item may itself open a panel or move focus, and it must
      // not have to fight a menu that is still up — exactly what lazygit's command-log toggle does
      // (extras_panel.go:19-29 pops the context first).
      this.close()
      pressed.onPress()
      return true
    },
    layout(host: Dimensions, terminalHeight: number) {
      if (!open) {
        box.visible = false
        return
      }
      const hostWidth = Math.max(1, host.x1 - host.x0 + 1)
      const hostHeight = Math.max(1, host.y1 - host.y0 + 1)
      const longest = items.reduce((widest, item) => Math.max(widest, item.key.length + item.label.length + 4), 0)
      const width = Math.max(20, Math.min(72, Math.min(hostWidth - 4, longest + 4)))
      const height = Math.max(3, Math.min(terminalHeight - 4, items.length + 2))
      box.left = host.x0 + Math.floor((hostWidth - width) / 2)
      box.top = host.y0 + Math.floor((hostHeight - height) / 2)
      box.width = width
      box.height = height
      box.visible = true
    },
  }
}

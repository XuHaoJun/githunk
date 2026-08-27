import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { DEFAULT_BACKGROUND, DEFAULT_FOREGROUND } from "./theme"
import type { MenuEntry } from "./bindings"
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
}

export function createKeybindingMenu(renderer: CliRenderer): KeybindingMenuHandle {
  const box = new BoxRenderable(renderer, {
    id: "keybinding-menu",
    border: true,
    borderColor: DEFAULT_FOREGROUND,
    focusedBorderColor: DEFAULT_FOREGROUND,
    titleColor: DEFAULT_FOREGROUND,
    title: "Keybindings",
    bottomTitle: "Escape or ? to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: DEFAULT_BACKGROUND,
  })
  const text = new TextRenderable(renderer, {
    id: "keybinding-menu-text",
    content: "",
    fg: DEFAULT_FOREGROUND,
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  box.visible = false
  return {
    box,
    update(entries: readonly MenuEntry[], contextTitle: string) {
      text.content = renderMenuLines(entries, contextTitle).join("\n")
    },
  }
}

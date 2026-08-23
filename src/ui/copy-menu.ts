import type { CopyMode } from "../domain/diff/document"

export type CopyMenuItem = {
  readonly label: string
  readonly mode: CopyMode
}

export const COPY_MENU_ITEMS: readonly CopyMenuItem[] = [
  { label: "Selected text", mode: "text" },
  { label: "Added code", mode: "added" },
  { label: "Removed code", mode: "removed" },
  { label: "As patch", mode: "patch" },
  { label: "Whole hunk", mode: "hunk" },
  { label: "File patch", mode: "file" },
]

export type CopyMenu = {
  readonly items: readonly CopyMenuItem[]
  readonly selectedIndex: number
}

export function createCopyMenu(selectedIndex = 0): CopyMenu {
  return { items: COPY_MENU_ITEMS, selectedIndex: Math.max(0, Math.min(selectedIndex, COPY_MENU_ITEMS.length - 1)) }
}

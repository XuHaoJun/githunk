import type { TextRenderable } from "@opentui/core"
import { getListSelectionRange, isListRangeActive, renderListRows, type ListState } from "../list-view"

/**
 * Installs a side list's rows as one styled document.
 *
 * OpenTUI 0.6 keeps the renderable tree native and leaves `TextRenderable.textBuffer` undefined, so
 * the line-indexed highlights 0.5 repainted cursor moves with are gone: `renderListRows` builds the
 * rows and this module hands them over as a single `StyledText`. Measured on 0.6.2 that encode costs
 * ~0.55 µs per row — 11 ms for a 20000-row list — and a re-install whose text *and* row visuals are
 * unchanged is free, so a refresh of an untouched list still costs nothing.
 *
 * `renderListRows` pads every row to the visible width in display cells, which is what lets a row's
 * selection background reach the right edge of the pane.
 */

export type ListTextContent = {
  readonly state: ListState
  /** Visible text width the rows are laid out and padded into. */
  readonly width: number
  readonly focused: boolean
  readonly hoveredId?: string
}

/** The content each pane was last installed with: row text, the rows carrying a background, and the
 * row objects themselves — a recolour replaces them while leaving the text byte-identical. */
const installedContents = new WeakMap<TextRenderable, { readonly signature: string; readonly rows: ListState["rows"] }>()

function contentSignature(content: ListTextContent, text: string): string {
  const range = content.focused && isListRangeActive(content.state) ? getListSelectionRange(content.state) : undefined
  return [text, content.focused ? "focused" : "unfocused", content.state.selectedId, content.hoveredId ?? "", range === undefined ? "" : `${range.startIndex}-${range.endIndex}`].join("\u0002")
}

/**
 * Installs list content. `./panes/list-text`'s callers re-install on every cursor move, so the
 * unchanged-content check above is what keeps a refresh that changes nothing from re-encoding rows.
 */
export function installListText(text: TextRenderable, content: ListTextContent): void {
  const rows = renderListRows(content.state, content.focused, content.width, content.hoveredId)
  const signature = contentSignature(content, rows.chunks.map((chunk) => chunk.text).join(""))
  const installed = installedContents.get(text)
  if (installed !== undefined && installed.signature === signature && installed.rows === content.state.rows) return
  installedContents.set(text, { signature, rows: content.state.rows })
  text.content = rows
}

/**
 * Forgets the installed rows, so the next install writes even if it holds the same characters. The
 * caller writes the pane's replacement text itself.
 */
export function releaseListText(text: TextRenderable): void {
  installedContents.delete(text)
}

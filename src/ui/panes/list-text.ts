import type { StyledText, TextRenderable } from "@opentui/core"
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

/**
 * The content each pane was last installed with: every chunk's text and paint, plus the rows carrying
 * a background. A rebuilt-but-identical row set is therefore a skip, which is what keeps a refresh
 * that changed nothing from re-encoding the list.
 */
const installedContents = new WeakMap<TextRenderable, string>()

function contentSignature(content: ListTextContent, rows: StyledText): string {
  const range = content.focused && isListRangeActive(content.state) ? getListSelectionRange(content.state) : undefined
  const chunks = rows.chunks.map((chunk) => `${chunk.text}\u0000${chunk.fg === undefined ? "" : chunk.fg.toInts().join(",")}\u0000${chunk.bg === undefined ? "" : chunk.bg.toInts().join(",")}\u0000${chunk.attributes ?? 0}`).join("\u0001")
  return [chunks, content.focused ? "focused" : "unfocused", content.state.selectedId, content.hoveredId ?? "", range === undefined ? "" : `${range.startIndex}-${range.endIndex}`].join("\u0002")
}

/**
 * Installs list content. `./panes/list-text`'s callers re-install on every cursor move and refresh, so
 * the unchanged-content check above is what keeps a refresh that changed nothing — including one that
 * rebuilt every row object from the same data — from re-encoding the list.
 */
export function installListText(text: TextRenderable, content: ListTextContent): void {
  const rows = renderListRows(content.state, content.focused, content.width, content.hoveredId)
  const signature = contentSignature(content, rows)
  if (installedContents.get(text) === signature) return
  installedContents.set(text, signature)
  text.content = rows
}

/**
 * Forgets the installed rows, so the next install writes even if it holds the same characters. The
 * caller writes the pane's replacement text itself.
 */
export function releaseListText(text: TextRenderable): void {
  installedContents.delete(text)
}

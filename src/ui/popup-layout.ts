import { cellWidth } from "./cell-width"

/**
 * Lazygit popup sizing, ported from
 * `pkg/gui/controllers/helpers/confirmation_helper.go`.
 *
 * `getPopupPanelWidth` and `getPopupPanelDimensionsAux` are the two helpers
 * every centered popup in lazygit goes through — confirmation (max 80),
 * menu (max 90), prompt (max 80) and commit-message (max 100 or
 * `autoWrapWidth+25`). Githunk previously centered its own confirmation
 * menu inside the main pane (`action-menu.ts:133-150`) with a `72` cap and
 * `hostWidth` math, so the delete-branch confirmation appeared in the
 * middle of panel 0 rather than the middle of the screen and was narrower
 * than lazygit's. This module is the single source of truth for that
 * math so every popup (action-menu, keybinding menu, future prompt
 * dialogs) can stay pixel-aligned with lazygit without duplicating the
 * size logic.
 */

const MIN_POPUP_WIDTH = 80
const TAB_WIDTH = 4

export function popupPanelWidth(terminalWidth: number, maxWidth: number): number {
  const width = Math.max(1, Math.floor(terminalWidth))
  const capped = Math.min(Math.floor((width * 4) / 7), maxWidth)
  if (capped < MIN_POPUP_WIDTH) {
    return Math.min(width - 2, MIN_POPUP_WIDTH)
  }
  return capped
}

export type PopupGeometry = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly contentWidth: number
  readonly contentHeight: number
}

/**
 * Mirrors `getPopupPanelDimensionsAux` without a parent popup (the common
 * case — no nested popups). The extra `- panelHeight%2` matches lazygit's
 * vertical centering bias for odd heights.
 */
export function popupPanelGeometry(
  terminalWidth: number,
  terminalHeight: number,
  contentWidth: number,
  contentHeight: number,
): PopupGeometry {
  const panelWidth = Math.max(1, contentWidth + 2)
  let panelHeight = Math.max(1, contentHeight + 2)
  const maxPanelHeight = Math.floor(Math.max(1, terminalHeight) * 3 / 4)
  if (panelHeight > maxPanelHeight) panelHeight = Math.max(1, maxPanelHeight)

  const tw = Math.max(1, Math.floor(terminalWidth))
  const th = Math.max(1, Math.floor(terminalHeight))

  // Integer-division mirroring Go's `width/2 - panelWidth/2`
  const left = Math.max(0, Math.floor(tw / 2) - Math.floor(panelWidth / 2))
  const top = Math.max(0, Math.floor(th / 2) - Math.floor(panelHeight / 2) - (panelHeight % 2))

  return {
    left,
    top,
    width: panelWidth,
    height: panelHeight,
    contentWidth,
    contentHeight,
  }
}

/**
 * Wraps `message` to `contentWidth` display cells, mirroring
 * `utils.WrapViewLinesToWidth(true, false, ...)` for the non-editable case.
 * Tabs are expanded to `TAB_WIDTH` spaces, then each logical line is broken
 * at the last space or '-' before the width limit, falling back to a hard
 * break. Returns the wrapped visual lines.
 */
export function wrapMessage(message: string, contentWidth: number, tabWidth = TAB_WIDTH): string[] {
  const width = Math.max(1, Math.floor(contentWidth))
  // Lazygit's WrapViewLinesToWidth trims a single trailing "\n" for
  // non-editable views before splitting.
  const normalized = message.endsWith("\n") ? message.slice(0, -1) : message
  const logicalLines = normalized.split("\n")
  const wrapped: string[] = []
  for (const logical of logicalLines) {
    const expanded = expandTabs(logical, tabWidth)
    if (expanded.length === 0) {
      wrapped.push("")
      continue
    }
    const pieces = wrapSingleLogicalLine(expanded, width)
    wrapped.push(...pieces)
  }
  // Preserve the case where the original message was exactly "" — one empty
  // visual line, which matches gocui's height of 1 for an empty buffer.
  if (logicalLines.length === 0) wrapped.push("")
  return wrapped
}

function expandTabs(line: string, tabWidth: number): string {
  if (!line.includes("\t")) return line
  // Go's tab expansion counts visual columns, not character indices. For the
  // prompts we actually wrap (English sentences, branch names) a fixed-width
  // replacement is indistinguishable and far simpler.
  return line.replaceAll("\t", " ".repeat(Math.max(1, tabWidth)))
}

function wrapSingleLogicalLine(line: string, width: number): string[] {
  if (cellWidth(line) <= width) return [line]
  // Use grapheme segmentation so wide emoji count as 2 cells, matching
  // `uniseg.StringWidth` in Go.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const graphemes = Array.from(segmenter.segment(line), (seg) => seg.segment)
  const out: string[] = []
  let start = 0
  while (start < graphemes.length) {
    let curWidth = 0
    let lastSpace = -1
    let i = start
    for (; i < graphemes.length; i++) {
      const g = graphemes[i]!
      const w = cellWidth(g)
      // Tabs already expanded, so no special case here.
      if (curWidth + w > width) break
      curWidth += w
      if (g === " " || g === "-") lastSpace = i
    }
    if (i === graphemes.length) {
      out.push(graphemes.slice(start).join(""))
      break
    }
    // Need to break before `i` (grapheme at `i` would overflow)
    if (lastSpace >= start) {
      const isHyphen = graphemes[lastSpace] === "-"
      // Go's wrapping keeps the hyphen on the next line when the break is
      // at the overflow hyphen itself, but keeps a prior hyphen at the end
      // of the line. Both fall out of the `lastSpace` index handling.
      if (lastSpace === i - 1 && isHyphen) {
        // overflow hyphen itself: break before it
        out.push(graphemes.slice(start, lastSpace).join(""))
        start = lastSpace
      } else if (isHyphen) {
        out.push(graphemes.slice(start, lastSpace + 1).join(""))
        start = lastSpace + 1
      } else {
        // space: exclude the space from both lines, skip leading spaces on next
        out.push(graphemes.slice(start, lastSpace).join(""))
        start = lastSpace + 1
        while (start < graphemes.length && graphemes[start] === " ") start++
      }
    } else {
      // hard break: line has no space/hyphen in the allowed window
      out.push(graphemes.slice(start, i).join(""))
      start = i
    }
  }
  return out
}

export function wrappedMessageHeight(message: string, contentWidth: number): number {
  return wrapMessage(message, contentWidth).length
}

/**
 * Confirmation popup (lazygit max 80) geometry for `message`.
 * Returns both the outer geometry and the derived content metrics so callers
 * can render the wrapped prompt without recomputing.
 */
export function confirmationPopupGeometry(
  terminalWidth: number,
  terminalHeight: number,
  message: string,
): PopupGeometry & { readonly wrappedPrompt: readonly string[] } {
  const panelWidth = popupPanelWidth(terminalWidth, 80)
  const contentWidth = Math.max(1, panelWidth - 2)
  const wrappedPrompt = wrapMessage(message, contentWidth)
  const contentHeight = wrappedPrompt.length
  const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
  return { ...geom, wrappedPrompt }
}

/**
 * Menu popup (lazygit max 90) geometry. `prompt` is the optional menu
 * prompt (as in `types.CreateMenuOptions.Prompt`), `itemCount` is the
 * number of menu items. The prompt is wrapped and an extra blank line is
 * counted after it when present, matching `layoutMenuPrompt`'s `append(
 * promptLines, "")` in confirmation_helper.go:356.
 */
export function menuPopupGeometry(
  terminalWidth: number,
  terminalHeight: number,
  itemCount: number,
  prompt = "",
): PopupGeometry & { readonly wrappedPrompt: readonly string[]; readonly promptLinesCount: number } {
  const panelWidth = popupPanelWidth(terminalWidth, 90)
  const contentWidth = Math.max(1, panelWidth - 2)
  const wrappedPrompt = prompt.length === 0 ? [] : wrapMessage(prompt, contentWidth)
  const promptLinesCount = wrappedPrompt.length === 0 ? 0 : wrappedPrompt.length + 1
  const offset = 3 // lazygit's `offset := 3` in resizeMenu
  const contentHeight = itemCount + offset + promptLinesCount
  const geom = popupPanelGeometry(terminalWidth, terminalHeight, contentWidth, contentHeight)
  // Lazygit's menu view height is `panelHeight - offset`, with a separate
  // tooltip view below it. Githunk renders the whole thing (prompt + items)
  // in one box, so the interesting content height excludes the offset's
  // tooltip reservation — but the outer geometry keeps it, matching the
  // screen-centering of the outer panel. Callers that render only
  // `prompt + items` should use `promptLinesCount + itemCount` for their
  // inner text height; the outer `geom.height` already includes the offset.
  return { ...geom, wrappedPrompt, promptLinesCount }
}

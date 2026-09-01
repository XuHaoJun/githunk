import { cellWidth } from "../cell-width"

export const HUNK_DIFF_RAIL_WIDTH = 1
export const HUNK_DIFF_SEPARATOR_WIDTH = 1
export const DEFAULT_HUNK_TAB_WIDTH = 4

function validTabWidth(tabWidth: number): number {
  if (!Number.isFinite(tabWidth)) return DEFAULT_HUNK_TAB_WIDTH
  return Math.max(1, Math.min(16, Math.floor(tabWidth)))
}

export function expandHunkDiffTabs(
  text: string,
  tabWidth = DEFAULT_HUNK_TAB_WIDTH,
  initialColumn = 0,
): string {
  const width = validTabWidth(tabWidth)
  let column = Math.max(0, Math.floor(initialColumn))
  let output = ""
  for (const character of text) {
    if (character === "\t") {
      const spaces = width - (column % width)
      output += " ".repeat(spaces)
      column += spaces
      continue
    }
    output += character
    column += cellWidth(character)
  }
  return output
}

export function measureHunkRenderedWidth(
  text: string,
  tabWidth = DEFAULT_HUNK_TAB_WIDTH,
): number {
  return cellWidth(expandHunkDiffTabs(text.replace(/\n$/u, ""), tabWidth))
}

export function resolveHunkSplitPaneWidths(width: number): { leftWidth: number; rightWidth: number } {
  const usableWidth = Math.max(0, Math.floor(width) - HUNK_DIFF_RAIL_WIDTH - HUNK_DIFF_SEPARATOR_WIDTH)
  const leftWidth = HUNK_DIFF_RAIL_WIDTH + Math.floor(usableWidth / 2)
  const rightWidth = HUNK_DIFF_SEPARATOR_WIDTH + usableWidth - Math.floor(usableWidth / 2)
  return { leftWidth: Math.max(0, leftWidth), rightWidth: Math.max(0, rightWidth) }
}

export function resolveHunkSplitCellGeometry(
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth = HUNK_DIFF_RAIL_WIDTH,
): { gutterWidth: number; contentWidth: number } {
  const availableWidth = Math.max(0, Math.floor(width) - prefixWidth)
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? Math.max(1, lineNumberDigits) + 3 : 2)
  return { gutterWidth, contentWidth: Math.max(0, availableWidth - gutterWidth) }
}

export function resolveHunkStackCellGeometry(
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth = HUNK_DIFF_RAIL_WIDTH,
): { gutterWidth: number; contentWidth: number } {
  const availableWidth = Math.max(0, Math.floor(width) - prefixWidth)
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? Math.max(1, lineNumberDigits) * 2 + 5 : 2)
  return { gutterWidth, contentWidth: Math.max(0, availableWidth - gutterWidth) }
}

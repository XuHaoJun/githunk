import { StyledText, parseColor, type TextChunk } from "@opentui/core"
import type { HunkDiffRow, HunkRenderSpan, HunkSplitCell, HunkStackCell } from "../hunk-diff-row-model"
import { resolveHunkSplitPaneWidths, resolveHunkSplitCellGeometry, resolveHunkStackCellGeometry, expandHunkDiffTabs } from "../hunk-code-columns"
import { cellWidth } from "../../cell-width"

const COLORS = {
  context: "#c5c8c6",
  addition: "#b9ca4a",
  deletion: "#cc6666",
  empty: "#666666",
  gutter: "#777777",
  header: "#7aa6da",
  separator: "#666666",
  collapsed: "#8c8c8c",
  feedback: "#c397d8",
} as const
const BACKGROUNDS = {
  panel: "#1e2329",
  context: "#0d1117",
  addition: "#173322",
  deletion: "#3c1e21",
  empty: "#272b31",
} as const

type Side = "left" | "right"

const colorCache = new Map<string, ReturnType<typeof parseColor>>()

function color(value: string) {
  const cached = colorCache.get(value)
  if (cached) return cached
  const parsed = parseColor(value)
  colorCache.set(value, parsed)
  return parsed
}

function chunk(text: string, fg?: string, bg?: string): TextChunk {
  return {
    __isChunk: true,
    text,
    ...(fg ? { fg: color(fg) } : {}),
    ...(bg ? { bg: color(bg) } : {}),
  }
}

function fitSpans(spans: readonly HunkRenderSpan[], width: number, fallbackFg: string): { spans: readonly HunkRenderSpan[]; usedWidth: number } {
  if (width <= 0) return { spans: [], usedWidth: 0 }
  const result: HunkRenderSpan[] = []
  let used = 0
  for (const span of spans) {
    const expanded = expandHunkDiffTabs(span.text)
    let text = ""
    let spanWidth = 0
    for (const character of expanded) {
      const characterWidth = cellWidth(character)
      if (used + spanWidth + characterWidth > width) break
      text += character
      spanWidth += characterWidth
    }
    if (text.length > 0) {
      result.push({ ...span, text, fg: span.fg ?? fallbackFg })
      used += spanWidth
    }
    if (used >= width) break
  }
  return { spans: result, usedWidth: used }
}

function padCells(text: string, width: number): string {
  const missing = Math.max(0, width - cellWidth(text))
  return missing > 0 ? `${text}${" ".repeat(missing)}` : text
}

function numberText(value: number | undefined, digits: number): string {
  return value === undefined ? " ".repeat(digits) : String(value).padStart(digits, " ")
}

function cellChunks(
  cell: HunkSplitCell,
  side: Side,
  width: number,
  digits: number,
  showLineNumbers: boolean,
): StyledText {
  const geometry = resolveHunkSplitCellGeometry(width, digits, showLineNumbers)
  const marker = side === "right" ? "│" : cell.kind === "empty" ? " " : cell.sign
  const markerColor = side === "right" ? COLORS.separator : COLORS[cell.kind]
  const gutter = showLineNumbers ? `${numberText(cell.lineNumber, digits)} ` : ""
  const gutterText = padCells(gutter, geometry.gutterWidth)
  const contentWidth = geometry.contentWidth
  const fallback = COLORS[cell.kind]
  const contentBackground = BACKGROUNDS[cell.kind]
  const gutterBackground = cell.kind === "empty" ? BACKGROUNDS.context : contentBackground
  const fitted = fitSpans(cell.spans, contentWidth, fallback)
  const chunks: TextChunk[] = [chunk(marker, markerColor, BACKGROUNDS.panel)]
  if (gutterText.length > 0) chunks.push(chunk(gutterText, COLORS.gutter, gutterBackground))
  for (const span of fitted.spans) chunks.push(chunk(span.text, span.fg ?? fallback, span.bg ?? contentBackground))
  chunks.push(chunk(" ".repeat(Math.max(0, contentWidth - fitted.usedWidth)), fallback, contentBackground))
  return new StyledText(chunks)
}

function stackChunks(
  cell: HunkStackCell,
  width: number,
  digits: number,
  showLineNumbers: boolean,
): StyledText {
  const geometry = resolveHunkStackCellGeometry(width, digits, showLineNumbers)
  const gutter = showLineNumbers
    ? `${numberText(cell.oldLineNumber, digits)} ${numberText(cell.newLineNumber, digits)} `
    : ""
  const gutterText = padCells(gutter, geometry.gutterWidth)
  const fallback = COLORS[cell.kind]
  const contentBackground = BACKGROUNDS[cell.kind]
  const gutterBackground = contentBackground
  const fitted = fitSpans(cell.spans, geometry.contentWidth, fallback)
  const chunks: TextChunk[] = [chunk(cell.sign, fallback, BACKGROUNDS.panel)]
  if (gutterText.length > 0) chunks.push(chunk(gutterText, COLORS.gutter, gutterBackground))
  for (const span of fitted.spans) chunks.push(chunk(span.text, span.fg ?? fallback, span.bg ?? contentBackground))
  chunks.push(chunk(" ".repeat(Math.max(0, geometry.contentWidth - fitted.usedWidth)), fallback, contentBackground))
  return new StyledText(chunks)
}

export type ReviewDiffRowProps = Readonly<{
  row: HunkDiffRow
  width: number
  digits: number
  showLineNumbers: boolean
  selected?: boolean
  onClick?: () => void
}>

export function ReviewDiffRow({ row, width, digits, showLineNumbers, onClick }: ReviewDiffRowProps) {
  const clickProps = onClick ? { onMouseUp: () => onClick() } : {}
  if (row.type === "hunk-header") {
    return (
      <box id={row.key} style={{ width: "100%", height: 1 }} {...clickProps}>
        <text content={new StyledText([chunk(row.text, COLORS.header)])} wrapMode="none" truncate={true} />
      </box>
    )
  }

  if (row.type === "collapsed") {
    return (
      <box id={row.key} style={{ width: "100%", height: 1 }} {...clickProps}>
        <text content={new StyledText([chunk(row.text, COLORS.collapsed)])} wrapMode="none" truncate={true} />
      </box>
    )
  }
  if (row.type === "feedback") {
    const style = row.resolution === "active" ? COLORS.feedback : COLORS.collapsed
    return (
      <box id={row.key} style={{ width: "100%", height: 1 }} {...clickProps}>
        <text content={new StyledText([chunk(row.text, style)])} wrapMode="none" truncate={true} />
      </box>
    )
  }

  if (row.type === "split-line") {
    const { leftWidth, rightWidth } = resolveHunkSplitPaneWidths(width)
    return (
      <box id={row.key} style={{ width: "100%", height: 1, flexDirection: "row" }} {...clickProps}>
        <text content={cellChunks(row.left, "left", leftWidth, digits, showLineNumbers)} wrapMode="none" truncate={true} />
        <text content={cellChunks(row.right, "right", rightWidth, digits, showLineNumbers)} wrapMode="none" truncate={true} />
      </box>
    )
  }

  return (
    <box id={row.key} style={{ width: "100%", height: 1 }} {...clickProps}>
      <text content={stackChunks(row.cell, width, digits, showLineNumbers)} wrapMode="none" truncate={true} />
    </box>
  )
}

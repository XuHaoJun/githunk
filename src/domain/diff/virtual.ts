import type { DiffDisplayLineStyle, DiffDocument, DiffLine } from "./document"
import { cellWidth } from "./cell-width"

export const VIRTUAL_DIFF_LINE_THRESHOLD = 10_000

export type VirtualDiffRow = {
  readonly text: string
  readonly gutterCols: number
  readonly style: DiffDisplayLineStyle
  readonly lineIndex?: number
  readonly rawStartUtf16?: number
  readonly rawEndUtf16?: number
  readonly displayStartUtf16: number
  readonly displayEndUtf16: number
}

export type VirtualDiffRowWindow = readonly [first: number, last: number]

export type VirtualDiffDisplayOffsets = {
  readonly rawStartUtf16: number
  readonly rawEndUtf16: number
  readonly displayStartUtf16: number
  readonly displayEndUtf16: number
}

export type VirtualDiffLayout = {
  readonly preambleRows: number
  readonly totalRows: number
  readonly contentWidth: number
  readonly rowAt: (row: number) => VirtualDiffRow | undefined
  readonly window: (scrollTop: number, viewportHeight: number, overscan: number) => VirtualDiffRowWindow
  readonly displayOffsetsForLines: (startIndex: number, endIndex: number) => VirtualDiffDisplayOffsets
  readonly rawOffsetAt: (row: number, column: number) => number | undefined
}

function isSourceLine(line: DiffLine): boolean {
  return line.kind === "context" || line.kind === "addition" || line.kind === "deletion"
}

function styleFor(line: DiffLine): DiffDisplayLineStyle {
  if (line.kind === "addition") return "addition"
  if (line.kind === "deletion") return "deletion"
  if (line.kind === "hunk-header") return "hunk-header"
  if (line.kind === "metadata" || line.kind === "no-newline") return "metadata"
  return "plain"
}

function lineNumberWidth(document: DiffDocument): number {
  let largest = 1
  for (const line of document.lines) {
    largest = Math.max(largest, line.oldLine ?? 0, line.newLine ?? 0)
  }
  return String(largest).length
}

function linePrefix(line: DiffLine, width: number): string {
  if (!isSourceLine(line)) return ""
  const old = line.oldLine === undefined ? "" : String(line.oldLine)
  const next = line.newLine === undefined ? "" : String(line.newLine)
  return `${old.padStart(width, " ")} ${next.padStart(width, " ")} `
}

function withoutLineEnding(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2)
  if (raw.endsWith("\n") || raw.endsWith("\r")) return raw.slice(0, -1)
  return raw
}

function normalizePreamble(preamble: string): { readonly text: string; readonly rows: readonly string[]; readonly starts: readonly number[]; readonly ends: readonly number[] } {
  if (preamble.length === 0) return { text: "", rows: [], starts: [], ends: [] }
  const text = preamble.endsWith("\n") ? preamble : `${preamble}\n`
  const rows = text.slice(0, -1).split("\n").map(withoutLineEnding)
  const starts: number[] = []
  const ends: number[] = []
  let start = 0
  for (let row = 0; row < rows.length; row += 1) {
    const newline = text.indexOf("\n", start)
    starts.push(start)
    ends.push(newline < 0 ? text.length : newline + 1)
    start = newline < 0 ? text.length : newline + 1
  }
  return { text, rows, starts, ends }
}

function boundedIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0 : length
  return Math.min(length, Math.max(0, Math.floor(value)))
}

export function createVirtualDiffLayout(document: DiffDocument, preamble: string): VirtualDiffLayout {
  const normalized = normalizePreamble(preamble)
  const width = lineNumberWidth(document)
  const prefixes = document.lines.map((line) => linePrefix(line, width))
  const displayStarts: number[] = new Array(document.lines.length)
  let displayLength = normalized.text.length
  let contentWidth = 0

  for (const row of normalized.rows) contentWidth = Math.max(contentWidth, cellWidth(row))
  for (let index = 0; index < document.lines.length; index += 1) {
    const line = document.lines[index]!
    const prefix = prefixes[index]!
    const text = `${prefix}${withoutLineEnding(line.raw)}`
    displayStarts[index] = displayLength
    displayLength += prefix.length + line.raw.length
    contentWidth = Math.max(contentWidth, cellWidth(text))
  }

  const totalRows = normalized.rows.length + document.lines.length
  const bodyRow = (lineIndex: number): VirtualDiffRow => {
    const line = document.lines[lineIndex]!
    const prefix = prefixes[lineIndex]!
    return {
      text: `${prefix}${withoutLineEnding(line.raw)}`,
      gutterCols: prefix.length,
      style: styleFor(line),
      lineIndex,
      rawStartUtf16: line.startUtf16,
      rawEndUtf16: line.endUtf16,
      displayStartUtf16: displayStarts[lineIndex]!,
      displayEndUtf16: displayStarts[lineIndex]! + prefix.length + line.raw.length,
    }
  }

  const rowAt = (row: number): VirtualDiffRow | undefined => {
    if (!Number.isSafeInteger(row) || row < 0 || row >= totalRows) return undefined
    if (row < normalized.rows.length) {
      const text = normalized.rows[row]!
      return {
        text,
        gutterCols: 0,
        style: "plain",
        displayStartUtf16: normalized.starts[row]!,
        displayEndUtf16: normalized.ends[row]!,
      }
    }
    return bodyRow(row - normalized.rows.length)
  }

  const window = (scrollTop: number, viewportHeight: number, overscan: number): VirtualDiffRowWindow => {
    const viewport = Math.max(0, Math.floor(Number.isFinite(viewportHeight) ? viewportHeight : 0))
    if (totalRows === 0 || viewport === 0) return [0, -1]
    const margin = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : 0))
    const maxScroll = Math.max(0, totalRows - viewport)
    const top = Math.min(maxScroll, Math.max(0, Math.floor(Number.isFinite(scrollTop) ? scrollTop : 0)))
    return [Math.max(0, top - margin), Math.min(totalRows - 1, top + viewport - 1 + margin)]
  }

  const displayOffsetsForLines = (startIndex: number, endIndex: number): VirtualDiffDisplayOffsets => {
    let start = boundedIndex(startIndex, document.lines.length)
    let end = boundedIndex(endIndex, document.lines.length)
    if (end < start) [start, end] = [end, start]
    const rawStartUtf16 = start < document.lines.length ? document.lines[start]!.startUtf16 : document.text.length
    const rawEndUtf16 = end < document.lines.length ? document.lines[end]!.startUtf16 : document.text.length
    const displayStartUtf16 = start < document.lines.length ? displayStarts[start]! : displayLength
    const displayEndUtf16 = end < document.lines.length ? displayStarts[end]! : displayLength
    return { rawStartUtf16, rawEndUtf16, displayStartUtf16, displayEndUtf16 }
  }

  const rawOffsetAt = (row: number, column: number): number | undefined => {
    const value = rowAt(row)
    if (value?.lineIndex === undefined || value.rawStartUtf16 === undefined || value.rawEndUtf16 === undefined) return undefined
    const line = document.lines[value.lineIndex]!
    const target = Math.max(0, Math.floor(Number.isFinite(column) ? column : 0))
    if (target <= value.gutterCols) return line.startUtf16

    const body = withoutLineEnding(line.raw)
    const bodyColumn = target - value.gutterCols
    let cells = 0
    let utf16 = 0
    for (const codePoint of body) {
      const widthInCells = cellWidth(codePoint)
      if (bodyColumn <= cells) return line.startUtf16 + utf16
      utf16 += codePoint.length
      cells += widthInCells
      if (bodyColumn <= cells) return line.startUtf16 + utf16
    }
    return line.endUtf16
  }

  return { preambleRows: normalized.rows.length, totalRows, contentWidth, rowAt, window, displayOffsetsForLines, rawOffsetAt }
}

import type { TextChunk } from "@opentui/core"
import { StyledText, bgBlue, cyan, dim, fg, green, magenta, yellow } from "@opentui/core"

export type ListColumnSegment = { readonly text: string; readonly color?: string | undefined }

export type ListColumn = {
  readonly text: string
  readonly priority: number
  readonly style?: "default" | "dim" | "cyan" | "green" | "yellow" | "magenta"
  /** Truecolor foreground (hex). Wins over `style` when set. */
  readonly color?: string
  /** Per-character colouring for `text`; the segments must concatenate back to `text`. */
  readonly segments?: readonly ListColumnSegment[]
  /** Absorbs leftover width and is never dropped; defaults to the last surviving column. */
  readonly flex?: boolean
}
export type ListRow = { readonly id: string; readonly columns: readonly ListColumn[] }
export type ListDisplayRow =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "header" | "message"; readonly text: string }

export type ListState = {
  readonly rows: readonly ListRow[]
  readonly displayRows: readonly ListDisplayRow[]
  readonly selectedId?: string
  readonly selectedIndex: number
  readonly scrollY: number
}

export type ListViewport = {
  readonly screenX: number
  readonly screenY: number
  readonly width: number
  readonly height: number
  readonly scrollY: number
}

function toDisplayRows(rows: readonly ListRow[], displayRows?: readonly ListDisplayRow[]): readonly ListDisplayRow[] {
  if (displayRows !== undefined) return displayRows
  return rows.map((row) => ({ kind: "item" as const, id: row.id }))
}

function resolveInitialSelection(rows: readonly ListRow[]): { selectedId?: string; selectedIndex: number } {
  if (rows.length === 0) return { selectedIndex: 0 }
  return { selectedId: rows[0]!.id, selectedIndex: 0 }
}

function resolveSelectionAfterChange(
  previousId: string | undefined,
  previousIndex: number,
  rows: readonly ListRow[],
): { selectedId?: string; selectedIndex: number } {
  if (rows.length === 0) return { selectedIndex: 0 }
  if (previousId !== undefined) {
    const found = rows.findIndex((row) => row.id === previousId)
    if (found !== -1) return { selectedId: previousId, selectedIndex: found }
  }
  if (previousIndex >= 0 && previousIndex < rows.length) {
    return { selectedId: rows[previousIndex]!.id, selectedIndex: previousIndex }
  }
  const clamped = Math.max(0, Math.min(rows.length - 1, previousIndex))
  const idx = Number.isFinite(clamped) ? clamped : 0
  const safeIdx = idx >= rows.length ? rows.length - 1 : idx < 0 ? 0 : idx
  return { selectedId: rows[safeIdx]!.id, selectedIndex: safeIdx }
}

export function createListState(rows: readonly ListRow[], displayRows?: readonly ListDisplayRow[]): ListState {
  const resolvedDisplayRows = toDisplayRows(rows, displayRows)
  const selection = resolveInitialSelection(rows)
  if (selection.selectedId === undefined) {
    return {
      rows,
      displayRows: resolvedDisplayRows,
      selectedIndex: selection.selectedIndex,
      scrollY: 0,
    }
  }
  return {
    rows,
    displayRows: resolvedDisplayRows,
    selectedId: selection.selectedId,
    selectedIndex: selection.selectedIndex,
    scrollY: 0,
  }
}

export function setListRows(state: ListState, rows: readonly ListRow[], displayRows?: readonly ListDisplayRow[]): ListState {
  const resolvedDisplayRows = toDisplayRows(rows, displayRows)
  const selection = resolveSelectionAfterChange(state.selectedId, state.selectedIndex, rows)
  if (selection.selectedId === undefined) {
    return {
      rows,
      displayRows: resolvedDisplayRows,
      selectedIndex: selection.selectedIndex,
      scrollY: state.scrollY,
    }
  }
  return {
    rows,
    displayRows: resolvedDisplayRows,
    selectedId: selection.selectedId,
    selectedIndex: selection.selectedIndex,
    scrollY: state.scrollY,
  }
}

export function moveListSelection(state: ListState, direction: "next" | "previous"): ListState {
  if (state.rows.length === 0) return state
  const delta = direction === "next" ? 1 : -1
  // Use selectedIndex as authoritative; if selection is undefined but rows exist, treat as 0
  let currentIndex = state.selectedIndex
  if (state.selectedId !== undefined) {
    const found = state.rows.findIndex((row) => row.id === state.selectedId)
    if (found !== -1) currentIndex = found
  } else if (currentIndex < 0 || currentIndex >= state.rows.length) {
    currentIndex = 0
  }
  const nextIndex = Math.max(0, Math.min(state.rows.length - 1, currentIndex + delta))
  const nextId = state.rows[nextIndex]!.id
  if (nextIndex === state.selectedIndex && nextId === state.selectedId) return state
  return {
    ...state,
    selectedId: nextId,
    selectedIndex: nextIndex,
  }
}

export function selectListRow(state: ListState, id: string): ListState {
  const idx = state.rows.findIndex((row) => row.id === id)
  if (idx === -1) return state
  if (state.selectedId === id && state.selectedIndex === idx) return state
  return {
    ...state,
    selectedId: id,
    selectedIndex: idx,
  }
}

export function listRowAtPoint(state: ListState, viewport: ListViewport, x: number, y: number): ListRow | undefined {
  if (x < viewport.screenX || x >= viewport.screenX + viewport.width) return undefined
  if (y < viewport.screenY || y >= viewport.screenY + viewport.height) return undefined
  const offset = y - viewport.screenY
  const rowIndex = viewport.scrollY + offset
  if (rowIndex < 0 || rowIndex >= state.displayRows.length) return undefined
  const displayRow = state.displayRows[rowIndex]!
  if (displayRow.kind !== "item") return undefined
  const row = state.rows.find((r) => r.id === displayRow.id)
  return row
}

// --- rendering ---

function plainChunk(text: string): TextChunk {
  return { __isChunk: true as const, text }
}

function styleToChunk(text: string, style: ListColumn["style"], color?: string): TextChunk {
  if (color !== undefined) return fg(color)(text) as TextChunk
  switch (style) {
    case "dim":
      return dim(text)
    case "cyan":
      return cyan(text)
    case "green":
      return green(text)
    case "yellow":
      return yellow(text)
    case "magenta":
      return magenta(text)
    case "default":
    case undefined:
      return plainChunk(text)
    default:
      return plainChunk(text)
  }
}

function visualLength(text: string): number {
  // Use spread to handle surrogate pairs; approximates width for ASCII tests
  return [...text].length
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  const chars = [...text]
  if (chars.length <= width) return text
  return chars.slice(0, width).join("")
}

/**
 * Column geometry for a whole list, mirroring lazygit's `utils.RenderDisplayStrings`:
 * every column is padded to the widest cell in that column so the ones after it line
 * up on every row, and columns that are blank on every row disappear entirely.
 *
 * Deciding this once per list — rather than per row — is what keeps a variable-width
 * cell (an author's initials, a graph lane) from shifting the rest of the row around.
 */
export type ListColumnLayout = {
  /** Indices into each row's `columns`, in render order. */
  readonly indexes: readonly number[]
  /** Rendered width for each entry of `indexes`. */
  readonly widths: readonly number[]
}

export function computeColumnLayout(rows: readonly ListRow[], width: number): ListColumnLayout {
  const safeWidth = Math.max(0, Math.floor(width))
  const columnCount = rows.reduce((max, row) => Math.max(max, row.columns.length), 0)
  if (columnCount === 0 || safeWidth === 0) return { indexes: [], widths: [] }

  const rawWidths: number[] = []
  const priorities: number[] = []
  const flexes: boolean[] = []
  for (let j = 0; j < columnCount; j++) {
    let maxWidth = 0
    let priority = 0
    let flex = false
    for (const row of rows) {
      const column = row.columns[j]
      if (column === undefined) continue
      maxWidth = Math.max(maxWidth, visualLength(column.text))
      priority = Math.max(priority, column.priority)
      if (column.flex === true) flex = true
    }
    rawWidths.push(maxWidth)
    priorities.push(priority)
    flexes.push(flex)
  }

  // Blank-everywhere columns are dropped, so an absent marker leaves no gap.
  let indexes = rawWidths.map((_, j) => j).filter((j) => rawWidths[j]! > 0)
  if (indexes.length === 0) return { indexes: [], widths: [] }

  // The flex column carries the row's primary content, so it shrinks instead of
  // disappearing. Without a declared one, the widest column plays that part.
  let flexIndex = indexes.find((j) => flexes[j] === true)
  if (flexIndex === undefined) {
    flexIndex = indexes.reduce((best, j) => (rawWidths[j]! > rawWidths[best]! ? j : best), indexes[0]!)
  }
  const minFlex = Math.max(1, Math.min(rawWidths[flexIndex]!, Math.floor(safeWidth / 2)))

  const spaceForFlex = (kept: readonly number[]): number =>
    safeWidth - kept.reduce((sum, j) => sum + (j === flexIndex ? 0 : rawWidths[j]!), 0) - Math.max(0, kept.length - 1)

  // Shed whole columns — least important first — only once squeezing the flex
  // column alone would leave it unreadably narrow.
  while (indexes.length > 1 && spaceForFlex(indexes) < minFlex) {
    let victim = -1
    for (const j of indexes) {
      if (j === flexIndex) continue
      if (victim === -1 || priorities[j]! > priorities[victim]! || (priorities[j] === priorities[victim] && j > victim)) {
        victim = j
      }
    }
    if (victim === -1) break
    indexes = indexes.filter((j) => j !== victim)
  }

  const flexWidth = Math.max(0, Math.min(rawWidths[flexIndex]!, spaceForFlex(indexes)))
  const widths = indexes.map((j) => (j === flexIndex ? flexWidth : rawWidths[j]!))
  return { indexes, widths }
}

function renderColumns(row: ListRow, layout: ListColumnLayout): TextChunk[] {
  const chunks: TextChunk[] = []
  for (let i = 0; i < layout.indexes.length; i++) {
    const column = row.columns[layout.indexes[i]!]
    const cellWidth = layout.widths[i]!
    const isLast = i === layout.indexes.length - 1
    if (i > 0) chunks.push(plainChunk(" "))
    const text = column?.text ?? ""
    const truncated = truncateToWidth(text, cellWidth)
    if (truncated.length > 0) {
      if (column?.segments !== undefined && truncated === text) {
        for (const segment of column.segments) {
          if (segment.text.length === 0) continue
          chunks.push(styleToChunk(segment.text, column.style, segment.color))
        }
      } else {
        chunks.push(styleToChunk(truncated, column?.style, column?.color))
      }
    }
    // The final column needs no trailing padding — nothing follows it to align.
    if (!isLast) {
      const pad = cellWidth - visualLength(truncated)
      if (pad > 0) chunks.push(plainChunk(" ".repeat(pad)))
    }
  }
  // Drop the separator runs left dangling when trailing columns rendered empty.
  while (chunks.length > 0 && chunks[chunks.length - 1]!.text.trim().length === 0) chunks.pop()
  return chunks
}

export function renderListRows(state: ListState, focused: boolean, width: number): StyledText {
  const safeWidth = Math.max(0, Math.floor(width))
  const displayRows = state.displayRows
  if (displayRows.length === 0) {
    return new StyledText([])
  }
  const rowMap = new Map(state.rows.map((r) => [r.id, r] as const))
  const visibleRows = displayRows.flatMap((dr) => {
    if (dr.kind !== "item") return []
    const row = rowMap.get(dr.id)
    return row === undefined ? [] : [row]
  })
  const layout = computeColumnLayout(visibleRows, safeWidth)
  const allChunks: TextChunk[] = []

  for (let i = 0; i < displayRows.length; i++) {
    const dr = displayRows[i]!
    const isSelected = focused && dr.kind === "item" && dr.id === state.selectedId
    let lineChunks: TextChunk[] = []

    if (dr.kind === "item") {
      const row = rowMap.get(dr.id)
      if (row) {
        lineChunks = renderColumns(row, layout)
      } else {
        lineChunks = []
      }
    } else {
      const truncated = truncateToWidth(dr.text, safeWidth)
      if (truncated.length > 0) {
        lineChunks = [plainChunk(truncated)]
      } else {
        lineChunks = []
      }
    }

    const shouldHighlight = isSelected && dr.kind === "item"

    if (shouldHighlight) {
      lineChunks = lineChunks.map((c) => bgBlue(c) as TextChunk)
      const plainLen = lineChunks.reduce((sum, c) => sum + visualLength(c.text), 0)
      const pad = Math.max(0, safeWidth - plainLen)
      if (pad > 0) {
        lineChunks.push(bgBlue(" ".repeat(pad)) as TextChunk)
      } else if (lineChunks.length === 0 && safeWidth > 0) {
        lineChunks.push(bgBlue(" ".repeat(safeWidth)) as TextChunk)
      }
    }

    for (const c of lineChunks) allChunks.push(c)
    if (i < displayRows.length - 1) {
      allChunks.push(plainChunk("\n"))
    }
  }

  return new StyledText(allChunks)
}

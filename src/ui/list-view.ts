import type { TextChunk } from "@opentui/core"
import { StyledText, bgBlue, cyan, dim, green, magenta, yellow } from "@opentui/core"

export type ListColumn = {
  readonly text: string
  readonly priority: number
  readonly style?: "default" | "dim" | "cyan" | "green" | "yellow" | "magenta"
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

function styleToChunk(text: string, style: ListColumn["style"]): TextChunk {
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

function renderColumns(columns: readonly ListColumn[], width: number): TextChunk[] {
  const safeWidth = Math.max(0, Math.floor(width))
  // Prepare mutable texts
  const texts = columns.map((c) => c.text)
  const styles = columns.map((c) => c.style)
  const priorities = columns.map((c) => c.priority)

  // Order indices by priority descending (least important first)
  const order = priorities
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => {
      if (b.p !== a.p) return b.p - a.p
      // For equal priority, truncate later columns first (stable-ish)
      return b.idx - a.idx
    })
    .map((o) => o.idx)

  const sepWidth = 1 // single space separator
  const sepCount = Math.max(0, columns.length - 1)

  let total = texts.reduce((sum, t) => sum + visualLength(t), 0) + sepCount * sepWidth

  if (total <= safeWidth) {
    // No truncation needed
  } else {
    let excess = total - safeWidth
    for (const idx of order) {
      if (excess <= 0) break
      const len = visualLength(texts[idx]!)
      if (len === 0) continue
      const reduceBy = Math.min(len, excess)
      const chars = [...texts[idx]!]
      const truncated = chars.slice(0, chars.length - reduceBy).join("")
      texts[idx] = truncated
      excess -= reduceBy
    }
    // If still excess after truncating all columns to zero, we will have separators left; handle by not rendering trailing separators
    // Recalculate total after loop – if still > width, we will handle separator trimming below
  }

  const chunks: TextChunk[] = []
  let first = true
  for (let i = 0; i < texts.length; i++) {
    const txt = texts[i]!
    // Skip empty columns? Keep them as zero-width but still need separator logic
    // If column became empty due to truncation, skip its chunk but keep separator handling minimal
    if (txt.length === 0) {
      // If we skipped, we should not add separator before it, but we already counted separators.
      // For simplicity, if all remaining leading columns are empty, just continue.
      // We'll emit separator only if we have emitted something before and there is a later non-empty column.
      // Instead we track emission.
      continue
    }
    if (!first) {
      chunks.push(plainChunk(" "))
    }
    first = false
    chunks.push(styleToChunk(txt, styles[i]) as TextChunk)
  }

  let plainLen = chunks.reduce((sum, c) => sum + visualLength(c.text), 0)
  if (plainLen > safeWidth) {
    let overflow = plainLen - safeWidth
    for (let i = chunks.length - 1; i >= 0 && overflow > 0; i--) {
      const c = chunks[i]!
      const len = visualLength(c.text)
      if (len === 0) continue
      if (len <= overflow) {
        overflow -= len
        chunks.splice(i, 1)
      } else {
        const chars = [...c.text]
        const kept = chars.slice(0, chars.length - overflow).join("")
        const next: TextChunk = { ...c, text: kept }
        chunks[i] = next
        overflow = 0
      }
    }
  }

  return chunks
}

export function renderListRows(state: ListState, focused: boolean, width: number): StyledText {
  const safeWidth = Math.max(0, Math.floor(width))
  const displayRows = state.displayRows
  if (displayRows.length === 0) {
    return new StyledText([])
  }
  const rowMap = new Map(state.rows.map((r) => [r.id, r] as const))
  const allChunks: TextChunk[] = []

  for (let i = 0; i < displayRows.length; i++) {
    const dr = displayRows[i]!
    const isSelected = focused && dr.kind === "item" && dr.id === state.selectedId
    let lineChunks: TextChunk[] = []

    if (dr.kind === "item") {
      const row = rowMap.get(dr.id)
      if (row) {
        lineChunks = renderColumns(row.columns, safeWidth)
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

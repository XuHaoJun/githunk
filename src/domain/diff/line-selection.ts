import type { DiffDocument } from "./document"

export type DiffLineRangeMode = "none" | "sticky" | "non-sticky"

export type DiffLineRangeState = {
  readonly lineCount: number
  readonly selectedIndex: number
  readonly rangeMode: DiffLineRangeMode
  readonly rangeStartIndex?: number
}

function clampIndex(index: number, lineCount: number): number {
  if (lineCount <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(lineCount - 1, Math.trunc(index)))
}

function withSelection(state: DiffLineRangeState, selectedIndex: number): DiffLineRangeState {
  const selected = clampIndex(selectedIndex, state.lineCount)
  // Preserve invariant: mode "none" implies no rangeStartIndex, even if a stale
  // index was carried via spread from a prior range (e.g. through adjustMainLineCursor).
  if (state.rangeMode === "none" && state.rangeStartIndex !== undefined) {
    return { lineCount: state.lineCount, selectedIndex: selected, rangeMode: "none" }
  }
  return { ...state, selectedIndex: selected }
}

function hasActiveRange(state: DiffLineRangeState): boolean {
  return state.rangeMode !== "none"
    && state.rangeStartIndex !== undefined
    && state.rangeStartIndex >= 0
    && state.rangeStartIndex < state.lineCount
    && state.selectedIndex >= 0
    && state.selectedIndex < state.lineCount
}

export function createDiffLineRangeState(document: DiffDocument): DiffLineRangeState {
  const selectedIndex = document.lines.findIndex((line) => line.kind === "addition" || line.kind === "deletion")
  return {
    lineCount: document.lines.length,
    selectedIndex: selectedIndex < 0 ? 0 : selectedIndex,
    rangeMode: "none",
  }
}

export function toggleDiffLineRange(state: DiffLineRangeState): DiffLineRangeState {
  if (state.rangeMode !== "none") {
    return {
      lineCount: state.lineCount,
      selectedIndex: clampIndex(state.selectedIndex, state.lineCount),
      rangeMode: "none",
    }
  }
  if (state.lineCount <= 0) return state
  return {
    ...state,
    selectedIndex: clampIndex(state.selectedIndex, state.lineCount),
    rangeMode: "sticky",
    rangeStartIndex: clampIndex(state.selectedIndex, state.lineCount),
  }
}

export function expandDiffLineRange(state: DiffLineRangeState, direction: "next" | "previous"): DiffLineRangeState {
  if (state.lineCount <= 0) return state
  const current = clampIndex(state.selectedIndex, state.lineCount)
  const delta = direction === "next" ? 1 : -1
  const nextIndex = clampIndex(current + delta, state.lineCount)
  if (hasActiveRange(state)) {
    if (nextIndex === current) return state
    return { ...state, selectedIndex: nextIndex }
  }
  if (nextIndex === current) return state
  return {
    ...state,
    selectedIndex: nextIndex,
    rangeMode: "non-sticky",
    rangeStartIndex: current,
  }
}

export function moveDiffLineSelection(state: DiffLineRangeState, direction: "next" | "previous"): DiffLineRangeState {
  if (state.lineCount <= 0) return state
  const current = clampIndex(state.selectedIndex, state.lineCount)
  const delta = direction === "next" ? 1 : -1
  const nextIndex = clampIndex(current + delta, state.lineCount)
  if (state.rangeMode === "sticky" && hasActiveRange(state)) {
    if (nextIndex === current) return state
    return { ...state, selectedIndex: nextIndex }
  }
  if (state.rangeMode !== "none") {
    return {
      lineCount: state.lineCount,
      selectedIndex: nextIndex,
      rangeMode: "none",
    }
  }
  if (nextIndex === current) return state
  return withSelection(state, nextIndex)
}

export function clearDiffLineRange(state: DiffLineRangeState): DiffLineRangeState {
  if (state.rangeMode === "none" && state.rangeStartIndex === undefined) return state
  return {
    lineCount: state.lineCount,
    selectedIndex: clampIndex(state.selectedIndex, state.lineCount),
    rangeMode: "none",
  }
}

export function diffLineSelectionRange(state: DiffLineRangeState): { readonly startIndex: number; readonly endIndex: number } {
  const selectedIndex = clampIndex(state.selectedIndex, state.lineCount)
  if (!hasActiveRange(state)) return { startIndex: selectedIndex, endIndex: selectedIndex }
  const startIndex = clampIndex(state.rangeStartIndex!, state.lineCount)
  return startIndex <= selectedIndex
    ? { startIndex, endIndex: selectedIndex }
    : { startIndex: selectedIndex, endIndex: startIndex }
}

export function changedIndexesInDiffLineRange(document: DiffDocument, state: DiffLineRangeState): readonly number[] {
  const { startIndex, endIndex } = diffLineSelectionRange(state)
  const last = Math.min(endIndex, document.lines.length - 1)
  if (last < startIndex) return []
  const indexes: number[] = []
  for (let index = Math.max(0, startIndex); index <= last; index += 1) {
    const kind = document.lines[index]!.kind
    if (kind === "addition" || kind === "deletion") indexes.push(index)
  }
  return indexes
}

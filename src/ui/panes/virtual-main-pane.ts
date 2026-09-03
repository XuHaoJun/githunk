import type { TextRenderable } from "@opentui/core"
import type { DiffDocument } from "../../domain/diff/document"
import { type DocumentSelection } from "../../domain/diff/selection"
import { createVirtualDiffLayout, VIRTUAL_DIFF_LINE_THRESHOLD, type VirtualDiffLayout } from "../../domain/diff/virtual"
import { cellWidth } from "../../domain/diff/cell-width"
import { clearScrollbarViewportOverride, type PaneHandle } from "./common"
import { installDiffText, releaseDiffText } from "./diff-text"
import { onPaneLifecyclePass } from "./pane-text"

const ACCESSORS = ["scrollY", "scrollHeight", "maxScrollY", "scrollX", "scrollWidth", "maxScrollX"] as const
type AccessorName = (typeof ACCESSORS)[number]
type AccessorDescriptor = PropertyDescriptor | undefined

const virtualPanes = new WeakMap<PaneHandle, VirtualMainPane>()

export const VIRTUAL_MAIN_OVERSCAN_MIN = 10

type VirtualState = {
  active: boolean
  document: DiffDocument | undefined
  layout: VirtualDiffLayout | undefined
  preamble: string
  scrollY: number
  scrollX: number
  viewportHeight: number
  viewportWidth: number
  rawSelection: DocumentSelection | undefined
  renderedWindow: readonly [number, number] | undefined
  originalDescriptors: ReadonlyMap<AccessorName, AccessorDescriptor>
  originalOwnDescriptors: ReadonlyMap<AccessorName, AccessorDescriptor>
}

export type VirtualMainPane = {
  install(document: DiffDocument, preamble: string): void
  deactivate(): void
  isActive(): boolean
  layout(): VirtualDiffLayout | undefined
  lineOffsets(startIndex: number, endIndex: number): { readonly startUtf16: number; readonly endUtf16: number; readonly displayStartUtf16: number; readonly displayEndUtf16: number } | undefined
  visualRowRange(startIndex: number, endIndex: number): { readonly startRow: number; readonly endRow: number } | undefined
  setLineSelection(startUtf16: number, endUtf16: number): void
  setPointerSelection(startRow: number, startColumn: number, endRow: number, endColumn: number): DocumentSelection | undefined
  selection(): DocumentSelection | undefined
  resetSelection(): void
  clampScroll(): void
}

function prototypeDescriptor(text: TextRenderable, name: AccessorName): PropertyDescriptor | undefined {
  let prototype: object | null = Object.getPrototypeOf(text)
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    if (descriptor !== undefined) return descriptor
    prototype = Object.getPrototypeOf(prototype)
  }
  return undefined
}

function isFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function documentSelection(document: DiffDocument, startUtf16: number, endUtf16: number): DocumentSelection {
  const line = document.lines.find((entry) => startUtf16 >= entry.startUtf16 && startUtf16 <= entry.endUtf16) ?? document.lines[0]
  return {
    valid: true,
    startUtf16,
    endUtf16,
    ...(line === undefined ? {} : {
      fileIndex: line.fileIndex,
      ...(line.hunkIndex === undefined ? {} : { hunkIndex: line.hunkIndex }),
    }),
    active: true,
  }
}

function dimensions(text: TextRenderable): { readonly height: number; readonly width: number } {
  return {
    height: Math.max(1, Math.floor(isFiniteNonNegative(text.height))),
    width: Math.max(0, Math.floor(isFiniteNonNegative(text.width))),
  }
}
function padDisplayRow(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - cellWidth(value)))}`
}

function installAccessors(pane: PaneHandle, state: VirtualState, rerender: () => void): void {
  const text = pane.text as unknown as Record<string, unknown>
  for (const name of ACCESSORS) {
    const descriptor = state.originalDescriptors.get(name)
    if (descriptor === undefined) continue
    const nextDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get: () => {
        if (!state.active) return descriptor.get?.call(text)
        const layout = state.layout
        if (name === "scrollY") return state.scrollY
        if (name === "scrollX") return state.scrollX
        if (name === "scrollHeight") return layout?.totalRows ?? descriptor.get?.call(text) ?? 0
        if (name === "scrollWidth") return layout?.contentWidth ?? descriptor.get?.call(text) ?? 0
        const viewport = name === "maxScrollY" ? state.viewportHeight : state.viewportWidth
        const size = name === "maxScrollY" ? (layout?.totalRows ?? 0) : (layout?.contentWidth ?? 0)
        return Math.max(0, size - viewport)
      },
      ...(name === "scrollY" || name === "scrollX" ? {
        set: (value: unknown): void => {
          if (!state.active) {
            descriptor.set?.call(text, value)
            return
          }
          const numeric = typeof value === "number" ? value : Number(value)
          if (name === "scrollY") {
            const max = Math.max(0, (state.layout?.totalRows ?? 0) - state.viewportHeight)
            const next = Math.min(max, Math.floor(isFiniteNonNegative(numeric)))
            if (state.scrollY === next) return
            state.scrollY = next
            rerender()
          } else {
            const max = Math.max(0, (state.layout?.contentWidth ?? 0) - state.viewportWidth)
            const next = Math.min(max, Math.floor(isFiniteNonNegative(numeric)))
            state.scrollX = next
            descriptor.set?.call(text, next)
            text.requestRender?.()
          }
        },
      } : {}),
    }
    Object.defineProperty(text, name, nextDescriptor)
  }
}

function createAdapter(pane: PaneHandle): VirtualMainPane {
  const text = pane.text
  const originalOwnDescriptors = new Map<AccessorName, AccessorDescriptor>(ACCESSORS.map((name) => [name, Object.getOwnPropertyDescriptor(text, name)]))
  const originalDescriptors = new Map<AccessorName, AccessorDescriptor>(ACCESSORS.map((name) => [name, Object.getOwnPropertyDescriptor(text, name) ?? prototypeDescriptor(text, name)]))
  const state: VirtualState = {
    active: false,
    preamble: "",
    scrollY: 0,
    scrollX: 0,
    viewportHeight: Math.max(1, Math.floor(text.height)),
    viewportWidth: Math.max(0, Math.floor(text.width)),
    originalDescriptors,
    originalOwnDescriptors,
  }

  const restoreAccessors = (): void => {
    const target = text as unknown as Record<string, unknown>
    for (const name of ACCESSORS) {
      delete target[name]
      const own = state.originalOwnDescriptors.get(name)
      if (own !== undefined) Object.defineProperty(target, name, own)
    }
  }

  const visibleSelection = (): { readonly start: number; readonly end: number } | undefined => {
    const selection = state.rawSelection
    const layout = state.layout
    const window = state.renderedWindow
    if (selection === undefined || layout === undefined || window === undefined) return undefined
    let start: number | undefined
    let end: number | undefined
    let localOffset = 0
    for (let row = window[0]; row <= window[1]; row += 1) {
      const current = layout.rowAt(row)
      if (current === undefined) continue
      const rowText = padDisplayRow(current.text, layout.contentWidth)
      const rowStart = localOffset
      localOffset += rowText.length + (row < window[1] ? 1 : 0)
      if (current.lineIndex === undefined || current.rawStartUtf16 === undefined || current.rawEndUtf16 === undefined) continue
      const overlapStart = Math.max(selection.startUtf16, current.rawStartUtf16)
      const overlapEnd = Math.min(selection.endUtf16, current.rawEndUtf16)
      if (overlapStart >= overlapEnd) continue
      const displayStart = rowStart + current.gutterCols + (overlapStart - current.rawStartUtf16)
      const displayEnd = rowStart + current.gutterCols + (overlapEnd - current.rawStartUtf16)
      start = start === undefined ? displayStart : Math.min(start, displayStart)
      end = end === undefined ? displayEnd : Math.max(end, displayEnd)
    }
    return start === undefined || end === undefined ? undefined : { start, end }
  }

  const paintSelection = (): void => {
    const selected = visibleSelection()
    const surface = text as unknown as { setSelection?: (start: number, end: number) => void; resetSelection?: () => void }
    if (selected === undefined) surface.resetSelection?.()
    else surface.setSelection?.(selected.start, selected.end)
  }

  const renderWindow = (): void => {
    if (!state.active || state.layout === undefined) return
    const current = dimensions(text)
    state.viewportHeight = current.height
    state.viewportWidth = current.width
    const max = Math.max(0, state.layout.totalRows - state.viewportHeight)
    if (state.scrollY > max) state.scrollY = max
    const maxX = Math.max(0, state.layout.contentWidth - state.viewportWidth)
    if (state.scrollX > maxX) state.scrollX = maxX
    const overscan = Math.max(VIRTUAL_MAIN_OVERSCAN_MIN, state.viewportHeight)
    const window = state.layout.window(state.scrollY, state.viewportHeight, overscan)
    const localScrollY = state.scrollY - window[0]
    state.renderedWindow = window
    const rows: string[] = []
    const displays = [] as Array<{ readonly gutterCols: number; readonly style: "plain" | "addition" | "deletion" | "hunk-header" | "metadata" }>
    const preambleRows: string[] = []
    const first = window[0]
    const last = window[1]
    if (last >= first && first < state.layout.preambleRows) {
      const preambleLast = Math.min(last, state.layout.preambleRows - 1)
      for (let row = first; row <= preambleLast; row += 1) {
        const value = state.layout.rowAt(row)
        if (value !== undefined) preambleRows.push(padDisplayRow(value.text, state.layout.contentWidth))
      }
    }
    const bodyFirst = Math.max(first, state.layout.preambleRows)
    for (let row = bodyFirst; row <= last; row += 1) {
      const value = state.layout.rowAt(row)
      if (value === undefined || value.lineIndex === undefined) continue
      rows.push(padDisplayRow(value.text, state.layout.contentWidth))
      displays.push({ gutterCols: value.gutterCols, style: value.style })
    }
    const preamble = preambleRows.length === 0 ? "" : `${preambleRows.join("\n")}\n`
    installDiffText(text, { preamble, body: rows.join("\n"), displayLines: displays, highlightScrollY: () => localScrollY })
    const originalScrollY = state.originalDescriptors.get("scrollY")?.set
    originalScrollY?.call(text, localScrollY)
    const originalScrollX = state.originalDescriptors.get("scrollX")?.set
    originalScrollX?.call(text, state.scrollX)
    paintSelection()
    pane.syncScrollbar(state.viewportHeight)
    text.requestRender?.()
  }

  const rerender = (): void => renderWindow()
  const adapter: VirtualMainPane = {
    install(document, preamble) {
      if (!state.active) {
        state.scrollY = isFiniteNonNegative(Number(text.scrollY))
        state.scrollX = isFiniteNonNegative(Number(text.scrollX))
      }
      state.active = true
      state.document = document
      state.layout = createVirtualDiffLayout(document, preamble)
      state.preamble = preamble
      const current = dimensions(text)
      state.viewportHeight = current.height
      state.viewportWidth = current.width
      installAccessors(pane, state, rerender)
      text.wrapMode = "none"
      renderWindow()
    },
    deactivate() {
      if (!state.active) return
      const originalY = state.originalDescriptors.get("scrollY")?.set
      const originalX = state.originalDescriptors.get("scrollX")?.set
      originalY?.call(text, state.scrollY)
      originalX?.call(text, state.scrollX)
      state.active = false
      state.document = undefined
      state.layout = undefined
      state.rawSelection = undefined
      state.renderedWindow = undefined
      releaseDiffText(text)
      restoreAccessors()
      clearScrollbarViewportOverride(text)
      text.wrapMode = "char"
    },
    isActive: () => state.active,
    layout: () => state.layout,
    lineOffsets: (startIndex, endIndex) => state.layout?.displayOffsetsForLines(startIndex, endIndex),
    visualRowRange: (startIndex, endIndex) => {
      if (state.layout === undefined) return undefined
      const start = state.layout.preambleRows + Math.max(0, startIndex)
      const end = state.layout.preambleRows + Math.max(startIndex, endIndex)
      return { startRow: start, endRow: end }
    },
    setLineSelection(startUtf16, endUtf16) {
      if (!state.active || state.document === undefined) return
      state.rawSelection = documentSelection(state.document, startUtf16, endUtf16)
      paintSelection()
    },
    setPointerSelection(startRow, startColumn, endRow, endColumn) {
      if (!state.active || state.layout === undefined || state.document === undefined) return undefined
      const start = state.layout.rawOffsetAt(Math.max(0, Math.floor(state.scrollY + startRow)), Math.max(0, Math.floor(state.scrollX + startColumn)))
      const end = state.layout.rawOffsetAt(Math.max(0, Math.floor(state.scrollY + endRow)), Math.max(0, Math.floor(state.scrollX + endColumn)))
      if (start === undefined || end === undefined) return undefined
      const selection = documentSelection(state.document, Math.min(start, end), Math.max(start, end))
      state.rawSelection = selection
      paintSelection()
      return selection
    },
    selection: () => state.rawSelection,
    resetSelection() {
      state.rawSelection = undefined
      ;(text as unknown as { resetSelection?: () => void }).resetSelection?.()
    },
    clampScroll() {
      if (!state.active || state.layout === undefined) {
        const originalY = state.originalDescriptors.get("scrollY")?.set
        const originalX = state.originalDescriptors.get("scrollX")?.set
        originalY?.call(text, text.scrollY)
        originalX?.call(text, text.scrollX)
        return
      }
      const maxY = Math.max(0, state.layout.totalRows - state.viewportHeight)
      const maxX = Math.max(0, state.layout.contentWidth - state.viewportWidth)
      state.scrollY = Math.min(maxY, Math.max(0, state.scrollY))
      state.scrollX = Math.min(maxX, Math.max(0, state.scrollX))
      renderWindow()
    },
  }
  onPaneLifecyclePass(text, () => {
    if (!state.active || state.layout === undefined) return
    const current = dimensions(text)
    if (current.height !== state.viewportHeight || current.width !== state.viewportWidth) renderWindow()
  })
  return adapter
}

export function createVirtualMainPane(pane: PaneHandle): VirtualMainPane {
  const existing = virtualPanes.get(pane)
  if (existing !== undefined) return existing
  const adapter = createAdapter(pane)
  virtualPanes.set(pane, adapter)
  return adapter
}

export function virtualMainPaneFor(pane: PaneHandle): VirtualMainPane | undefined {
  return virtualPanes.get(pane)
}

export function isVirtualDiffDocument(document: DiffDocument): boolean {
  return document.lines.length > VIRTUAL_DIFF_LINE_THRESHOLD
}

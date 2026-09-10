import type { TextRenderable } from "@opentui/core"
import type { DiffDocument } from "../../domain/diff/document"
import { type DocumentSelection } from "../../domain/diff/selection"
import type { MainSelectionProjection, MainSelectionProjectionSegment } from "../../domain/diff/selection-projection"
import { createVirtualDiffLayout, VIRTUAL_DIFF_LINE_THRESHOLD, type VirtualDiffDisplayOffsets, type VirtualDiffLayout } from "../../domain/diff/virtual"
import { cellWidth } from "../../domain/diff/cell-width"
import { clearScrollbarViewportOverride, type PaneHandle } from "./common"
import { installDiffText, releaseDiffText, statSpansForPreamble, type DiffStatSpan, type InstalledPaneText } from "./diff-text"
import { onPaneLifecyclePass } from "./pane-text"

const ACCESSORS = ["scrollY", "scrollHeight", "maxScrollY", "scrollX", "scrollWidth", "maxScrollX"] as const
type AccessorName = (typeof ACCESSORS)[number]
type AccessorDescriptor = PropertyDescriptor | undefined

const virtualPanes = new WeakMap<PaneHandle, VirtualMainPane>()

export type VirtualMainPaneSelectionPort = {
  readonly publishProjection: (draft: Omit<MainSelectionProjection, "generation">) => void
  readonly currentDocumentSelection: () => DocumentSelection | undefined
}
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
  renderedWindow: readonly [number, number] | undefined
  renderedContentWidth: number | undefined
  preambleSpans: ReadonlyMap<number, readonly DiffStatSpan[]>
  originalDescriptors: ReadonlyMap<AccessorName, AccessorDescriptor>
  originalOwnDescriptors: ReadonlyMap<AccessorName, AccessorDescriptor>
}

export type VirtualMainPane = {
  install(document: DiffDocument, preamble: string): void
  deactivate(): void
  isActive(): boolean
  layout(): VirtualDiffLayout | undefined
  lineOffsets(startIndex: number, endIndex: number): VirtualDiffDisplayOffsets | undefined
  visualRowRange(startIndex: number, endIndex: number): { readonly startRow: number; readonly endRow: number } | undefined
  setLineSelection(startUtf16: number, endUtf16: number): void
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

function withoutLineEnding(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2)
  if (raw.endsWith("\n") || raw.endsWith("\r")) return raw.slice(0, -1)
  return raw
}

function rawDisplayCells(raw: string, relativeUtf16: number, includeLineEnding: boolean): number {
  const body = withoutLineEnding(raw)
  const prefixLength = Math.min(body.length, Math.max(0, Math.floor(relativeUtf16)))
  const cells = cellWidth(body.slice(0, prefixLength))
  return cells + (includeLineEnding && prefixLength >= body.length && body.length < raw.length ? 1 : 0)
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
            pane.text.requestRender()
          }
        },
      } : {}),
    }
    Object.defineProperty(text, name, nextDescriptor)
  }
}

function createAdapter(pane: PaneHandle, selectionPort: VirtualMainPaneSelectionPort): VirtualMainPane {
  const text = pane.text
  const originalOwnDescriptors = new Map<AccessorName, AccessorDescriptor>(ACCESSORS.map((name) => [name, Object.getOwnPropertyDescriptor(text, name)] as const))
  const originalDescriptors = new Map<AccessorName, AccessorDescriptor>(ACCESSORS.map((name) => [name, Object.getOwnPropertyDescriptor(text, name) ?? prototypeDescriptor(text, name)] as const))
  const state: VirtualState = {
    active: false,
    document: undefined,
    layout: undefined,
    preamble: "",
    scrollY: 0,
    scrollX: 0,
    viewportHeight: Math.max(1, Math.floor(text.height)),
    viewportWidth: Math.max(0, Math.floor(text.width)),
    renderedWindow: undefined,
    renderedContentWidth: undefined,
    preambleSpans: new Map(),
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
    const selection = selectionPort.currentDocumentSelection()
    const layout = state.layout
    const window = state.renderedWindow
    if (selection === undefined || layout === undefined || window === undefined) return undefined
    let start: number | undefined
    let end: number | undefined
    let localOffset = 0
    for (let row = window[0]; row <= window[1]; row += 1) {
      const current = layout.rowAt(row)
      if (current === undefined) continue
      const rowStart = localOffset
      localOffset += layout.contentWidth + (row < window[1] ? 1 : 0)
      if (current.lineIndex === undefined || current.rawStartUtf16 === undefined || current.rawEndUtf16 === undefined) continue
      const line = state.document?.lines[current.lineIndex]
      if (line === undefined) continue
      const overlapStart = Math.max(selection.startUtf16, current.rawStartUtf16)
      const overlapEnd = Math.min(selection.endUtf16, current.rawEndUtf16)
      if (overlapStart >= overlapEnd) continue
      const displayStart = rowStart + (overlapStart === current.rawStartUtf16 ? 0 : current.gutterCols + rawDisplayCells(line.raw, overlapStart - current.rawStartUtf16, false))
      const displayEnd = rowStart + current.gutterCols + rawDisplayCells(line.raw, overlapEnd - current.rawStartUtf16, overlapEnd > current.rawStartUtf16 + withoutLineEnding(line.raw).length)
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
    const previousWindow = state.renderedWindow
    const projectionWindowChanged = previousWindow === undefined
      || previousWindow[0] !== window[0]
      || previousWindow[1] !== window[1]
    const projectionContentChanged = state.renderedContentWidth !== state.layout.contentWidth
    const localScrollY = state.scrollY - window[0]
    state.renderedWindow = window
    state.renderedContentWidth = state.layout.contentWidth
    const rows: string[] = []
    const displays = [] as Array<{ readonly gutterCols: number; readonly style: "plain" | "addition" | "deletion" | "hunk-header" | "metadata" }>
    const preambleRows: string[] = []
    const projectionSegments: MainSelectionProjectionSegment[] = []
    let projectionCursor = 0
    const appendSegment = (segment: MainSelectionProjectionSegment): void => {
      if (segment.displayEndUtf16 <= segment.displayStartUtf16) return
      projectionSegments.push(segment)
      projectionCursor = segment.displayEndUtf16
    }
    const appendDecoration = (length: number): void => {
      appendSegment({ kind: "decoration", displayStartUtf16: projectionCursor, displayEndUtf16: projectionCursor + length })
    }
    const preambleSpans = new Map<number, readonly DiffStatSpan[]>()
    const first = window[0]
    const last = window[1]
    if (last >= first && first < state.layout.preambleRows) {
      const preambleLast = Math.min(last, state.layout.preambleRows - 1)
      for (let row = first; row <= preambleLast; row += 1) {
        const value = state.layout.rowAt(row)
        if (value !== undefined) {
          const padded = padDisplayRow(value.text, state.layout.contentWidth)
          preambleRows.push(padded)
          appendSegment({ kind: "text", displayStartUtf16: projectionCursor, displayEndUtf16: projectionCursor + value.text.length })
          appendDecoration(padded.length - value.text.length)
          appendSegment({ kind: "text", displayStartUtf16: projectionCursor, displayEndUtf16: projectionCursor + 1 })
        }
        const spans = state.preambleSpans.get(row)
        if (spans !== undefined) preambleSpans.set(row - first, spans)
      }
    }
    const bodyFirst = Math.max(first, state.layout.preambleRows)
    for (let row = bodyFirst; row <= last; row += 1) {
      const value = state.layout.rowAt(row)
      if (value === undefined || value.lineIndex === undefined) continue
      const padded = padDisplayRow(value.text, state.layout.contentWidth)
      rows.push(padded)
      displays.push({ gutterCols: value.gutterCols, style: value.style })
      appendDecoration(value.gutterCols)
      const line = state.document!.lines[value.lineIndex]!
      const body = value.text.slice(value.gutterCols)
      appendSegment({
        kind: "document",
        displayStartUtf16: projectionCursor,
        displayEndUtf16: projectionCursor + body.length,
        rawStartUtf16: line.startUtf16,
        rawEndUtf16: line.startUtf16 + body.length,
        lineIndex: value.lineIndex,
      })
      appendDecoration(padded.length - value.text.length)
      if (row < last) {
        const rawBodyEnd = line.startUtf16 + withoutLineEnding(line.raw).length
        if (rawBodyEnd < line.endUtf16) {
          appendSegment({
            kind: "document",
            displayStartUtf16: projectionCursor,
            displayEndUtf16: projectionCursor + 1,
            rawStartUtf16: rawBodyEnd,
            rawEndUtf16: line.endUtf16,
            lineIndex: value.lineIndex,
          })
        } else {
          appendDecoration(1)
        }
      }
    }
    const preamble = preambleRows.length === 0 ? "" : `${preambleRows.join("\n")}\n`
    const body = rows.join("\n")
    const installed: InstalledPaneText = installDiffText(text, { preamble, body, displayLines: displays, highlightScrollY: () => localScrollY, preambleSpans })
    if (projectionCursor !== installed.text.length) throw new Error("virtual main selection projection does not cover installed text")
    const originalScrollY = state.originalDescriptors.get("scrollY")?.set
    if (projectionWindowChanged || projectionContentChanged) {
      selectionPort.publishProjection({ document: state.document!, text: installed.text, segments: projectionSegments })
    }
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
      state.preambleSpans = statSpansForPreamble(preamble)
      const current = dimensions(text)
      state.viewportHeight = current.height
      state.viewportWidth = current.width
      installAccessors(pane, state, rerender)
      state.renderedWindow = undefined
      state.renderedContentWidth = undefined
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
      releaseDiffText(text)
      state.preambleSpans = new Map()
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
    setLineSelection(_startUtf16, _endUtf16) {
      if (!state.active) return
      paintSelection()
    },
    resetSelection() {
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
      const nextY = Math.min(maxY, Math.max(0, state.scrollY))
      const nextX = Math.min(maxX, Math.max(0, state.scrollX))
      const current = dimensions(text)
      const unchanged = nextY === state.scrollY
        && nextX === state.scrollX
        && current.height === state.viewportHeight
        && current.width === state.viewportWidth
      state.scrollY = nextY
      state.scrollX = nextX
      if (unchanged) return
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

export function createVirtualMainPane(pane: PaneHandle, selectionPort: VirtualMainPaneSelectionPort): VirtualMainPane {
  const existing = virtualPanes.get(pane)
  if (existing !== undefined) return existing
  const adapter = createAdapter(pane, selectionPort)
  virtualPanes.set(pane, adapter)
  return adapter
}

export function virtualMainPaneFor(pane: PaneHandle): VirtualMainPane | undefined {
  return virtualPanes.get(pane)
}

export function isVirtualDiffDocument(document: DiffDocument): boolean {
  return document.lines.length > VIRTUAL_DIFF_LINE_THRESHOLD
}

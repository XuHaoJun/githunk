import { parseColor, type RGBA, type TextRenderable } from "@opentui/core"
import { cellWidth } from "../../domain/diff/cell-width"
import {
  computeColumnLayout,
  getListSelectionRange,
  isListRangeActive,
  layoutListRowSegments,
  renderListRows,
  type ListDisplayRow,
  type ListRow,
  type ListState,
} from "../list-view"
import {
  ANSI_CYAN,
  ANSI_GREEN,
  ANSI_MAGENTA,
  ANSI_YELLOW,
  HOVER_LINE_BG,
  SELECTED_LINE_BG,
  brightenAnsiForeground,
} from "../theme"
import { paneTextBuffer, type PaneTextBuffer } from "./pane-text"
import { createViewportHighlights, LINE_END_COLS, type ViewportHighlights } from "./viewport-highlights"

/**
 * Side-list styling through the shared text-buffer machinery (`./pane-text`,
 * `./viewport-highlights`) instead of per-keypress full `StyledText` installs.
 *
 * `renderListRows` (`../list-view`) rebuilds chunks for every row on each cursor
 * move, and assigning that to `TextRenderable.content` costs chunks × lines
 * (see `./pane-text`): ~57ms at 500 rows, seconds at 5000. This painter installs
 * the same row text once per content change with the buffer's `setText` (linear
 * and cheap) and paints colours as line-indexed highlights: selection, hover,
 * and range moves repaint only the rows whose visual state changed.
 *
 * Row text is built from `layoutListRowSegments`, so the installed text can
 * never disagree with the `StyledText` renderer about what a row says; only
 * trailing padding differs (every installed row is padded to full width so a
 * full-row selection background reaches the right edge).
 */

export type ListTextContent = {
  readonly state: ListState
  /** Visible text width the rows are laid out and padded into. */
  readonly width: number
  readonly focused: boolean
  readonly hoveredId?: string
}

/** Per-row visual state, mirroring `renderListRows`' selection model exactly. */
type RowVisual = 0 | 1 | 2 | 3 // plain | selected | range | hover

type ResolvedSegment = {
  readonly text: string
  readonly fg?: RGBA
  readonly dim?: boolean
}

type LayoutCache = {
  readonly rows: readonly ListRow[]
  readonly width: number
  readonly rowTexts: readonly string[]
  readonly rowSegments: ReadonlyArray<readonly ResolvedSegment[]>
  readonly joined: string
}

type Snapshot = {
  readonly rowSegments: ReadonlyArray<readonly ResolvedSegment[]>
  readonly visuals: readonly RowVisual[]
}

type PainterRecord = {
  readonly buffer: PaneTextBuffer
  viewport: ViewportHighlights<SnapshotRef>
  readonly ref: SnapshotRef
  readonly styleIds: Map<string, number>
  cache: LayoutCache | undefined
  joined: string
  visuals: readonly RowVisual[]
}

type SnapshotRef = { snap: Snapshot | undefined }

const painters = new WeakMap<TextRenderable, PainterRecord>()

function resolveSegment(
  text: string,
  style: "default" | "dim" | "cyan" | "green" | "yellow" | "magenta" | undefined,
  color: unknown,
): ResolvedSegment {
  let fg: RGBA | undefined
  let dim: boolean | undefined
  if (color !== undefined) {
    // `styleToChunk` lets an explicit color win over the column style; same here.
    fg = parseColor(color as Parameters<typeof parseColor>[0])
  } else {
    switch (style) {
      case "dim":
        dim = true
        break
      case "cyan":
        fg = ANSI_CYAN
        break
      case "green":
        fg = ANSI_GREEN
        break
      case "yellow":
        fg = ANSI_YELLOW
        break
      case "magenta":
        fg = ANSI_MAGENTA
        break
      case "default":
      case undefined:
        break
    }
  }
  return {
    text,
    ...(fg === undefined ? {} : { fg }),
    ...(dim === undefined ? {} : { dim }),
  }
}

function styleKey(fg: RGBA | undefined, bold: boolean, dim: boolean, bg: RGBA | undefined): string {
  const fgKey = fg === undefined ? "" : fg.toInts().join(",")
  const bgKey = bg === undefined ? "" : bg.toInts().join(",")
  return `${fgKey}|${bold ? 1 : 0}|${dim ? 1 : 0}|${bgKey}`
}

function styleIdFor(
  record: PainterRecord,
  fg: RGBA | undefined,
  bold: boolean,
  dim: boolean,
  bg: RGBA | undefined,
): number {
  const key = styleKey(fg, bold, dim, bg)
  const cached = record.styleIds.get(key)
  if (cached !== undefined) return cached
  const id = record.buffer.registerStyle(`githunk.list.${record.styleIds.size}`, {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(bold ? { bold } : {}),
    ...(dim ? { dim } : {}),
  })
  record.styleIds.set(key, id)
  return id
}

function rowVisual(
  state: ListState,
  focused: boolean,
  hoveredId: string | undefined,
  rowIndexById: ReadonlyMap<string, number>,
  range: { readonly startIndex: number; readonly endIndex: number } | undefined,
  displayRow: ListDisplayRow,
): RowVisual {
  if (displayRow.kind !== "item") return 0
  if (focused && displayRow.id === state.selectedId) return 1
  if (range !== undefined) {
    const index = rowIndexById.get(displayRow.id)
    if (index !== undefined && index >= range.startIndex && index <= range.endIndex) return 2
  }
  // Hover paints regardless of focus, exactly like `renderListRows`.
  if (displayRow.id === hoveredId) return 3
  return 0
}
function layoutFor(state: ListState, safeWidth: number): LayoutCache {
  const displayRows = state.displayRows
  const rowMap = new Map(state.rows.map((row) => [row.id, row] as const))
  // Same visible-row set and layout the `StyledText` renderer uses.
  const visibleRows = displayRows.flatMap((dr) => {
    if (dr.kind !== "item") return []
    const row = rowMap.get(dr.id)
    return row === undefined ? [] : [row]
  })
  const layout = computeColumnLayout(visibleRows, safeWidth)
  const rowTexts: string[] = []
  const rowSegments: ResolvedSegment[][] = []
  for (const dr of displayRows) {
    if (dr.kind !== "item") {
      // `renderListRows` truncates message/header rows and paints nothing.
      const truncated = [...dr.text].slice(0, safeWidth).join("")
      rowTexts.push(truncated)
      rowSegments.push(truncated.length === 0 ? [] : [{ text: truncated }])
      continue
    }
    const row = rowMap.get(dr.id)
    const laidOut = row === undefined
      ? []
      : layoutListRowSegments(row, layout).map((segment) => resolveSegment(segment.text, segment.style, segment.color))
    const joined = laidOut.map((segment) => segment.text).join("")
    // Pad to full width so a full-row selection background reaches the right edge.
    const pad = Math.max(0, safeWidth - cellWidth(joined))
    rowTexts.push(pad === 0 ? joined : `${joined}${" ".repeat(pad)}`)
    rowSegments.push(laidOut)
  }
  return { rows: state.rows, width: safeWidth, rowTexts, rowSegments, joined: rowTexts.join("\n") }
}

function visualsFor(state: ListState, focused: boolean, hoveredId: string | undefined): readonly RowVisual[] {
  const rowIndexById = new Map(state.rows.map((row, index) => [row.id, index] as const))
  const rangeActive = focused && isListRangeActive(state)
  const range = rangeActive ? getListSelectionRange(state) : undefined
  return state.displayRows.map((dr) => rowVisual(state, focused, hoveredId, rowIndexById, range, dr))
}

function paintRow(record: PainterRecord, line: number): void {
  const snap = record.ref.snap
  if (snap === undefined) return
  const segments = snap.rowSegments[line]
  const visual = snap.visuals[line]
  if (segments === undefined || visual === undefined) return
  const { buffer } = record
  buffer.clearRow(line)
  const bg = visual === 1 || visual === 2 ? SELECTED_LINE_BG : visual === 3 ? HOVER_LINE_BG : undefined
  let column = 0
  for (const segment of segments) {
    const cells = cellWidth(segment.text)
    if (cells > 0) {
      if (visual === 1) {
        // `highlightChunk` in `../list-view` (gocui `View.setCharacter`): promote
        // the foreground, OR in bold, and replace the background.
        buffer.addHighlight(line, {
          start: column,
          end: column + cells,
          styleId: styleIdFor(
            record,
            segment.fg === undefined ? undefined : brightenAnsiForeground(segment.fg),
            true,
            segment.dim === true,
            bg,
          ),
        })
      } else if (bg !== undefined) {
        // Range and hover keep the base foreground, adding only the background.
        buffer.addHighlight(line, {
          start: column,
          end: column + cells,
          styleId: styleIdFor(record, segment.fg, false, segment.dim === true, bg),
        })
      } else if (segment.fg !== undefined || segment.dim === true) {
        buffer.addHighlight(line, {
          start: column,
          end: column + cells,
          styleId: styleIdFor(record, segment.fg, false, segment.dim === true, undefined),
        })
      }
    }
    column += cells
  }
  if (bg !== undefined) {
    buffer.addHighlight(line, { start: column, end: LINE_END_COLS, styleId: styleIdFor(record, undefined, false, false, bg) })
  }
}

function ensurePainter(text: TextRenderable, buffer: PaneTextBuffer): PainterRecord {
  const existing = painters.get(text)
  if (existing !== undefined) return existing
  const ref: SnapshotRef = { snap: undefined }
  const record: PainterRecord = {
    buffer,
    viewport: undefined as unknown as ViewportHighlights<SnapshotRef>,
    ref,
    styleIds: new Map(),
    cache: undefined,
    joined: "",
    visuals: [],
  }
  record.viewport = createViewportHighlights<SnapshotRef>(text, {
    buffer,
    paintLine: (line) => paintRow(record, line),
  })
  painters.set(text, record)
  return record
}

/**
 * Installs list content: full text goes in once per content change, colours
 * repaint in the viewport band, and selection/hover/range moves repaint only
 * the rows whose visual state changed — never a full reinstall.
 *
 * Invariant: a pane owned by this painter must never be written through
 * `pane.update`/direct `content=` while list rows are installed — native styled
 * writes detach the highlight layer with no recovery on byte-identical
 * reinstalls. Release first (`releaseListText`), then write the plain text.
 */
export function installListText(text: TextRenderable, content: ListTextContent): void {
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    // Degrades in speed rather than colour if OpenTUI reshapes its internals.
    text.content = renderListRows(content.state, content.focused, content.width, content.hoveredId)
    return
  }
  const record = ensurePainter(text, buffer)
  const safeWidth = Math.max(0, Math.floor(content.width))
  const previousCache = record.cache
  // Layout (column widths, row text, segments) is O(rows): recompute only when
  // the row objects or the width changed. Selection moves keep both, so they
  // pay only the visuals scan below.
  const cache = previousCache !== undefined && previousCache.rows === content.state.rows && previousCache.width === safeWidth
    ? previousCache
    : layoutFor(content.state, safeWidth)
  record.cache = cache
  const visuals = visualsFor(content.state, content.focused, content.hoveredId)
  record.ref.snap = { rowSegments: cache.rowSegments, visuals }
  if (cache.joined !== record.joined) {
    record.joined = cache.joined
    record.visuals = visuals
    record.viewport.install(cache.joined, record.ref)
    return
  }
  if (cache !== previousCache) {
    // Same text, new row objects (a refresh that changed colours but no text):
    // repaint the band without reinstalling the text.
    record.visuals = visuals
    record.viewport.repaint()
    record.buffer.refresh()
    return
  }
  // Same rows and text: repaint only rows whose visual state changed.
  const previous = record.visuals
  record.visuals = visuals
  let repainted = false
  const lines = Math.max(previous.length, visuals.length)
  for (let line = 0; line < lines; line++) {
    if (previous[line] !== visuals[line]) {
      paintRow(record, line)
      repainted = true
    }
  }
  if (repainted) record.buffer.refresh()
}
/**
 * Hands the pane back to plain content. The caller writes the replacement text
 * itself; this only drops the list's highlights so they cannot bleed into it.
 */
export function releaseListText(text: TextRenderable): void {
  const record = painters.get(text)
  if (record === undefined) return
  record.viewport.release()
  record.buffer.refresh()
  painters.delete(text)
}

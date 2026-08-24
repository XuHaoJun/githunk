import { arrangeWindows, type Box, type Dimensions } from "./boxlayout"
import type { FocusId } from "./focus"

export const MIN_LEFT_WIDTH = 18
export const MIN_MAIN_WIDTH = 40
export const MIN_MAIN_HEIGHT = 8
export const MIN_LOG_HEIGHT = 3
export const SPLITTER_SIZE = 1
export const DEFAULT_SIDE_PANEL_RATIO = 0.3333
export const DEFAULT_LOG_HEIGHT = 8
/** Focused side pane height relative to its siblings. lazygit's expandedSidePanelWeight. */
export const EXPANDED_SIDE_PANEL_WEIGHT = 2
export const STATUS_PANE_HEIGHT = 3
export const FOLDED_PANE_HEIGHT = 3
export const MIN_HEIGHT_FOR_NORMAL_LAYOUT = 28
export const MIN_HEIGHT_FOR_TALL_SQUASHED = 21

export type ScreenMode = "normal" | "half" | "full"
export const SCREEN_MODES: readonly ScreenMode[] = ["normal", "half", "full"]

export type SideWindow = "status" | "files" | "branches" | "commits" | "stash"
export const SIDE_WINDOWS: readonly SideWindow[] = ["status", "files", "branches", "commits", "stash"]

export type WindowName = SideWindow | "vsplit" | "main" | "hsplit" | "log" | "hints" | "info"

export type TerminalSize = {
  readonly width: number
  readonly height: number
}

export type LayoutRequest = {
  readonly sidePanelRatio?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly focus?: FocusId
  readonly screenMode?: ScreenMode
  readonly hintsVisible?: boolean
  readonly statusWidth?: number
  readonly accordion?: boolean
}

export type LayoutGeometry = {
  readonly terminalWidth: number
  readonly terminalHeight: number
  /** A window absent from this map is hidden. */
  readonly windows: Readonly<Partial<Record<WindowName, Dimensions>>>
  readonly sidePanelRatio: number
  readonly sideWidth: number
  readonly logHeight: number
  readonly logVisible: boolean
  readonly screenMode: ScreenMode
  readonly hintsVisible: boolean
  readonly tooSmall: boolean
}

export function widthOf(dimensions: Dimensions | undefined): number {
  return dimensions === undefined ? 0 : Math.max(0, dimensions.x1 - dimensions.x0 + 1)
}

export function heightOf(dimensions: Dimensions | undefined): number {
  return dimensions === undefined ? 0 : Math.max(0, dimensions.y1 - dimensions.y0 + 1)
}

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isSideWindow(focus: FocusId): focus is FocusId & SideWindow {
  return (SIDE_WINDOWS as readonly string[]).includes(focus)
}

export function nextScreenMode(current: ScreenMode): ScreenMode {
  const index = SCREEN_MODES.indexOf(current)
  return SCREEN_MODES[Math.min(SCREEN_MODES.length - 1, index + 1)] ?? current
}

export function previousScreenMode(current: ScreenMode): ScreenMode {
  const index = SCREEN_MODES.indexOf(current)
  return SCREEN_MODES[Math.max(0, index - 1)] ?? current
}

/**
 * The five left panes. `focusedSide` is undefined when focus is on the main
 * pane or the command log; `absorber` is the pane that takes a weight in the
 * layouts where every other pane is statically sized, because boxlayout needs
 * at least one weighted box to soak up the remaining rows.
 */
function sideChildren(
  focusedSide: SideWindow | undefined,
  accordion: boolean,
  enlarged: boolean,
): (width: number, height: number) => readonly Box[] {
  const absorber = focusedSide ?? "files"
  return (_width, height) => {
    if (enlarged) {
      return [{ window: absorber, weight: 1 }]
    }
    if (height >= MIN_HEIGHT_FOR_NORMAL_LAYOUT) {
      return SIDE_WINDOWS.map((window): Box => {
        if (window === "status") return { window, size: STATUS_PANE_HEIGHT }
        const focused = window === focusedSide
        if (window === "stash" && !focused) return { window, size: FOLDED_PANE_HEIGHT }
        return { window, weight: accordion && focused ? EXPANDED_SIDE_PANEL_WEIGHT : 1 }
      })
    }
    const squashed = height >= MIN_HEIGHT_FOR_TALL_SQUASHED ? FOLDED_PANE_HEIGHT : 1
    return SIDE_WINDOWS.map((window) =>
      window === absorber ? { window, weight: 1 } : { window, size: squashed },
    )
  }
}

export function computeLayout(terminal: TerminalSize, requested: LayoutRequest = {}): LayoutGeometry {
  const terminalWidth = safeDimension(terminal.width)
  const terminalHeight = safeDimension(terminal.height)
  const focus: FocusId = requested.focus ?? "main"
  const screenMode = requested.screenMode ?? "normal"
  const accordion = requested.accordion !== false
  const hintsVisible = requested.hintsVisible !== false
  const logVisible = requested.logVisible === true
  const requestedRatio = Number.isFinite(requested.sidePanelRatio ?? Number.NaN)
    ? clamp(requested.sidePanelRatio as number, 0, 1)
    : DEFAULT_SIDE_PANEL_RATIO
  const requestedLog = Number.isFinite(requested.logHeight ?? Number.NaN)
    ? Math.floor(requested.logHeight as number)
    : DEFAULT_LOG_HEIGHT

  const infoHeight = hintsVisible && terminalHeight >= 2 ? 1 : 0
  const bodyHeight = terminalHeight - infoHeight

  const widthTooSmall = terminalWidth < MIN_LEFT_WIDTH + SPLITTER_SIZE + MIN_MAIN_WIDTH
  const heightTooSmall = logVisible
    ? bodyHeight < MIN_MAIN_HEIGHT + SPLITTER_SIZE + MIN_LOG_HEIGHT
    : bodyHeight < MIN_MAIN_HEIGHT
  const tooSmall = widthTooSmall || heightTooSmall

  const focusedSide = isSideWindow(focus) ? focus : undefined
  const enlargedSide = screenMode !== "normal" && focusedSide !== undefined
  const sideCollapsed = screenMode !== "normal" && focusedSide === undefined
  const mainCollapsed = screenMode === "full" && focusedSide !== undefined

  // A terminal too narrow to host both regions hides whichever one the user did
  // not just ask to enlarge, rather than hiding both.
  const sideHidden = sideCollapsed || (widthTooSmall && !enlargedSide)
  const mainHidden = mainCollapsed || (widthTooSmall && enlargedSide)

  let sideWidth: number
  if (sideHidden) sideWidth = 0
  else if (mainHidden) sideWidth = terminalWidth
  else {
    const target = screenMode === "half" ? Math.floor(terminalWidth / 2) : Math.round(terminalWidth * requestedRatio)
    sideWidth = clamp(target, MIN_LEFT_WIDTH, terminalWidth - SPLITTER_SIZE - MIN_MAIN_WIDTH)
  }
  const splitterWidth = sideWidth > 0 && !mainHidden ? SPLITTER_SIZE : 0
  const mainWidth = mainHidden ? 0 : terminalWidth - sideWidth - splitterWidth

  const logCapacity = bodyHeight - SPLITTER_SIZE - MIN_MAIN_HEIGHT
  const logHeight = !logVisible || mainWidth === 0 || logCapacity < MIN_LOG_HEIGHT
    ? 0
    : clamp(requestedLog, MIN_LOG_HEIGHT, logCapacity)
  const logSplitterHeight = logHeight > 0 ? SPLITTER_SIZE : 0

  const mainSectionChildren: Box[] = [{ window: "main", weight: 1 }]
  if (logHeight > 0) {
    mainSectionChildren.push({ window: "hsplit", size: logSplitterHeight })
    mainSectionChildren.push({ window: "log", size: logHeight })
  }

  const bodyChildren: Box[] = []
  if (sideWidth > 0) {
    bodyChildren.push({
      direction: "row",
      ...(mainWidth === 0 ? { weight: 1 } : { size: sideWidth }),
      conditionalChildren: sideChildren(focusedSide, accordion, enlargedSide),
    })
  }
  if (splitterWidth > 0) bodyChildren.push({ window: "vsplit", size: splitterWidth })
  if (mainWidth > 0) bodyChildren.push({ direction: "row", weight: 1, children: mainSectionChildren })

  const statusWidth = Number.isFinite(requested.statusWidth ?? Number.NaN)
    ? clamp(Math.floor(requested.statusWidth as number), 0, terminalWidth)
    : 0
  const infoChildren: Box[] = [{ window: "hints", weight: 1 }]
  if (statusWidth > 0) infoChildren.push({ window: "info", size: statusWidth })

  const rootChildren: Box[] = [{ direction: "column", weight: 1, children: bodyChildren }]
  if (infoHeight > 0) rootChildren.push({ direction: "column", size: infoHeight, children: infoChildren })

  const rawWindows = arrangeWindows(
    { direction: "row", children: rootChildren },
    0,
    0,
    terminalWidth,
    terminalHeight,
  ) as Readonly<Partial<Record<WindowName, Dimensions>>>

  // A window absent from this map is hidden, per the documented contract, so a
  // pane squeezed to zero width or height by the engine must not linger here.
  const windows: Partial<Record<WindowName, Dimensions>> = {}
  for (const [name, dimensions] of Object.entries(rawWindows) as [WindowName, Dimensions][]) {
    if (widthOf(dimensions) > 0 && heightOf(dimensions) > 0) windows[name] = dimensions
  }

  return {
    terminalWidth,
    terminalHeight,
    windows,
    sidePanelRatio: requestedRatio,
    sideWidth,
    logHeight,
    logVisible,
    screenMode,
    hintsVisible: infoHeight > 0,
    tooSmall,
  }
}

export function ratioForMouseX(geometry: LayoutGeometry, mouseX: number): number {
  if (!Number.isFinite(mouseX) || geometry.terminalWidth <= 0) return geometry.sidePanelRatio
  return clamp(mouseX / geometry.terminalWidth, 0, 1)
}

export function logHeightForMouseY(geometry: LayoutGeometry, mouseY: number): number {
  if (!Number.isFinite(mouseY)) return geometry.logHeight
  const bodyHeight = geometry.terminalHeight - (geometry.hintsVisible ? 1 : 0)
  return Math.max(0, bodyHeight - Math.floor(mouseY) - SPLITTER_SIZE)
}


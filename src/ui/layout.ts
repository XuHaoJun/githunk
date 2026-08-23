export const MIN_LEFT_WIDTH = 18
export const MIN_MAIN_WIDTH = 40
export const MIN_MAIN_HEIGHT = 8
export const MIN_LOG_HEIGHT = 3
export const VERTICAL_SPLITTER_WIDTH = 1
export const HORIZONTAL_SPLITTER_HEIGHT = 1

export type TerminalSize = {
  readonly width: number
  readonly height: number
}

export type LayoutRequest = {
  readonly leftWidth?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
}

export type LayoutGeometry = {
  readonly terminalWidth: number
  readonly terminalHeight: number
  readonly leftWidth: number
  readonly leftX: number
  readonly leftHeight: number
  readonly verticalSplitterX: number
  readonly verticalSplitterWidth: number
  readonly rightX: number
  readonly mainWidth: number
  readonly mainY: number
  readonly mainHeight: number
  readonly horizontalSplitterY: number
  readonly horizontalSplitterHeight: number
  readonly logY: number
  readonly logHeight: number
  readonly logVisible: boolean
  readonly tooSmall: boolean
}

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function computeLayout(terminal: TerminalSize, requested: LayoutRequest = {}): LayoutGeometry {
  const terminalWidth = safeDimension(terminal.width)
  const terminalHeight = safeDimension(terminal.height)
  const requestedLeft = Number.isFinite(requested.leftWidth ?? NaN)
    ? Math.floor(requested.leftWidth as number)
    : 30
  const requestedLog = Number.isFinite(requested.logHeight ?? NaN)
    ? Math.floor(requested.logHeight as number)
    : 8
  const logVisible = requested.logVisible !== false

  // Leave one cell for the divider whenever both content regions can retain a cell.
  const verticalSplitterWidth = terminalWidth >= 3 ? VERTICAL_SPLITTER_WIDTH : 0
  const leftCapacity = Math.max(0, terminalWidth - verticalSplitterWidth - 1)
  const leftMaximum = terminalWidth >= MIN_LEFT_WIDTH + VERTICAL_SPLITTER_WIDTH + MIN_MAIN_WIDTH
    ? terminalWidth - VERTICAL_SPLITTER_WIDTH - MIN_MAIN_WIDTH
    : leftCapacity
  const leftWidth = leftCapacity === 0
    ? 0
    : clamp(requestedLeft, terminalWidth >= MIN_LEFT_WIDTH + VERTICAL_SPLITTER_WIDTH + MIN_MAIN_WIDTH ? MIN_LEFT_WIDTH : 1, leftMaximum)
  const mainWidth = terminalWidth - leftWidth - verticalSplitterWidth

  const canShowHorizontalSplitter = logVisible && terminalHeight >= 3
  const horizontalSplitterHeight = canShowHorizontalSplitter ? HORIZONTAL_SPLITTER_HEIGHT : 0
  const verticalContentHeight = terminalHeight - horizontalSplitterHeight
  const logCapacity = Math.max(0, verticalContentHeight - 1)
  const logMinimum = terminalHeight >= MIN_MAIN_HEIGHT + HORIZONTAL_SPLITTER_HEIGHT + MIN_LOG_HEIGHT ? MIN_LOG_HEIGHT : 1
  const logMaximum = terminalHeight >= MIN_MAIN_HEIGHT + HORIZONTAL_SPLITTER_HEIGHT + MIN_LOG_HEIGHT
    ? terminalHeight - HORIZONTAL_SPLITTER_HEIGHT - MIN_MAIN_HEIGHT
    : logCapacity
  const logHeight = !logVisible || logCapacity === 0
    ? 0
    : clamp(requestedLog, logMinimum, logMaximum)
  const mainHeight = terminalHeight - horizontalSplitterHeight - logHeight
  const logY = mainHeight + horizontalSplitterHeight

  const tooSmall = mainWidth < MIN_MAIN_WIDTH || mainHeight < MIN_MAIN_HEIGHT
  return {
    terminalWidth,
    terminalHeight,
    leftWidth,
    leftX: 0,
    leftHeight: terminalHeight,
    verticalSplitterX: leftWidth,
    verticalSplitterWidth,
    rightX: leftWidth + verticalSplitterWidth,
    mainWidth,
    mainY: 0,
    mainHeight,
    horizontalSplitterY: mainHeight,
    horizontalSplitterHeight,
    logY,
    logHeight,
    logVisible,
    tooSmall,
  }
}

export function resizeLeftPane(current: LayoutGeometry, mouseX: number): LayoutGeometry {
  return computeLayout(
    { width: current.terminalWidth, height: current.terminalHeight },
    { leftWidth: mouseX, logHeight: current.logHeight, logVisible: current.logVisible },
  )
}

export function resizeCommandLog(current: LayoutGeometry, mouseY: number): LayoutGeometry {
  const requestedLogHeight = current.terminalHeight - Math.floor(mouseY) - current.horizontalSplitterHeight
  return computeLayout(
    { width: current.terminalWidth, height: current.terminalHeight },
    { leftWidth: current.leftWidth, logHeight: requestedLogHeight, logVisible: current.logVisible },
  )
}

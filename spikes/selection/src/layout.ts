const MIN_LEFT = 18
const MIN_RIGHT = 40
const SPLITTER_WIDTH = 1

export type PaneLayout = {
  terminalWidth: number
  leftWidth: number
  splitterX: number
  rightWidth: number
}

export function computePaneLayout(
  terminalWidth: number,
  requestedLeftWidth: number,
): PaneLayout {
  const maxLeft = Math.max(MIN_LEFT, terminalWidth - MIN_RIGHT - SPLITTER_WIDTH)
  const leftWidth = Math.min(Math.max(requestedLeftWidth, MIN_LEFT), maxLeft)
  return {
    terminalWidth,
    leftWidth,
    splitterX: leftWidth,
    rightWidth: Math.max(0, terminalWidth - leftWidth - SPLITTER_WIDTH),
  }
}

export function resizeLeftPane(current: PaneLayout, mouseX: number): PaneLayout {
  return computePaneLayout(current.terminalWidth, mouseX)
}

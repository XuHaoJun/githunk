import type { TextRenderable } from "@opentui/core"
import { paneTextBuffer } from "../panes/pane-text"
import { cellWidth } from "../cell-width"
import type { ReviewRow } from "./row-planner"

const painters = new WeakMap<TextRenderable, { release: () => void }>()

export function installReviewStreamHighlights(text: TextRenderable, fullText: string, rows: readonly ReviewRow[]): void {
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    // Fallback: set plain content if buffer not available (e.g., older OpenTUI)
    ;(text as unknown as { content: string }).content = fullText
    return
  }
  buffer.setText(fullText)
  // Clear any previous highlights (buffer.setText already drops highlights)
  // Register styles per unique fg and also for diff addition/deletion plain styles if needed
  const styleIds = new Map<string, number>()
  const getStyleId = (fg: string): number => {
    let id = styleIds.get(fg)
    if (id !== undefined) return id
    // Register with fg as ColorInput; OpenTUI accepts hex string
    id = buffer.registerStyle(`review-hl-${fg.replaceAll("#", "").replaceAll("/", "-")}`, { fg: fg as unknown as never })
    styleIds.set(fg, id)
    return id
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!
    if (row.kind !== "diff" && row.kind !== "hunk-header" && row.kind !== "file-header") continue
    let col = 0
    for (const span of row.text) {
      const w = cellWidth(span.text)
      if (w === 0) {
        col += w
        continue
      }
      const fg = (span as unknown as { fg?: string }).fg
      if (fg) {
        const styleId = getStyleId(fg)
        buffer.addHighlight(rowIndex, { start: col, end: col + w, styleId })
      }
      col += w
    }
  }
  painters.set(text, {
    release: () => {
      try {
        buffer.clearAllHighlights()
      } catch {}
    },
  })
}

export function releaseReviewStreamHighlights(text: TextRenderable): void {
  const painter = painters.get(text)
  if (painter) {
    try {
      painter.release()
    } catch {}
    painters.delete(text)
  } else {
    const buffer = paneTextBuffer(text)
    try {
      buffer?.clearAllHighlights()
    } catch {}
  }
}

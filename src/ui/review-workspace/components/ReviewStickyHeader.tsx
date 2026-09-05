import { StyledText, parseColor, type TextChunk } from "@opentui/core"
import { cellWidth } from "../../cell-width"
import type { StickyDiffHeader } from "../sticky-header"

// Deliberately distinct from the stream's own header rows so the pinned copy
// cannot be mistaken for content, as jesseduffield/lazygit#5836 asks for.
const STICKY_BACKGROUND = "#2b3138"
const PATH_FOREGROUND = "#e0e2e4"
const HUNK_FOREGROUND = "#7aa6da"

const colorCache = new Map<string, ReturnType<typeof parseColor>>()

function color(value: string) {
  const cached = colorCache.get(value)
  if (cached) return cached
  const parsed = parseColor(value)
  colorCache.set(value, parsed)
  return parsed
}

function chunk(text: string, fg: string): TextChunk {
  return { __isChunk: true, text, fg: color(fg), bg: color(STICKY_BACKGROUND) }
}

/** Truncate to `width` terminal cells, not code units: paths carry wide characters. */
function fit(text: string, width: number): { text: string; used: number } {
  if (width <= 0) return { text: "", used: 0 }
  let out = ""
  let used = 0
  for (const character of text) {
    const characterWidth = cellWidth(character)
    if (used + characterWidth > width) break
    out += character
    used += characterWidth
  }
  return { text: out, used }
}

export function stickyHeaderChunks(sticky: StickyDiffHeader, width: number): readonly TextChunk[] {
  if (width <= 0) return []
  const chunks: TextChunk[] = []
  // The hunk range is the part that changes as you scroll, so it keeps its
  // width and the path gives way first.
  const hunkText = sticky.hunkText ?? ""
  const hunkWidth = hunkText.length === 0 ? 0 : Math.min(width, cellWidth(hunkText) + 2)
  const path = fit(sticky.filePath, Math.max(0, width - hunkWidth))
  if (path.text.length > 0) chunks.push(chunk(path.text, PATH_FOREGROUND))

  let used = path.used
  if (hunkText.length > 0 && used < width) {
    const separator = fit("  ", width - used)
    if (separator.text.length > 0) {
      chunks.push(chunk(separator.text, PATH_FOREGROUND))
      used += separator.used
    }
    const hunk = fit(hunkText, width - used)
    if (hunk.text.length > 0) {
      chunks.push(chunk(hunk.text, HUNK_FOREGROUND))
      used += hunk.used
    }
  }
  if (used < width) chunks.push(chunk(" ".repeat(width - used), PATH_FOREGROUND))
  return chunks
}

export function ReviewStickyHeader({ sticky, width }: Readonly<{ sticky: StickyDiffHeader; width: number }>) {
  return (
    <box
      id="review-sticky-header"
      style={{ width: "100%", height: 1, flexShrink: 0, backgroundColor: STICKY_BACKGROUND }}
    >
      <text content={new StyledText([...stickyHeaderChunks(sticky, Math.max(0, width))])} wrapMode="none" truncate={true} />
    </box>
  )
}

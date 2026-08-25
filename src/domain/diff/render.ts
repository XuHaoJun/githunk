import type { DiffDisplayLine, DiffDisplayLineStyle, DiffDocument, DiffLine, DisplayOffsetMap, DisplaySourceSegment } from "./document"

function sourceLine(line: DiffLine): boolean {
  return line.kind === "context" || line.kind === "addition" || line.kind === "deletion"
}

function lineNumberWidth(document: DiffDocument): number {
  let largest = 1
  for (const line of document.lines) {
    largest = Math.max(largest, line.oldLine ?? 0, line.newLine ?? 0)
  }
  return String(largest).length
}

function styleFor(line: DiffLine): DiffDisplayLineStyle {
  if (line.kind === "addition") return "addition"
  if (line.kind === "deletion") return "deletion"
  if (line.kind === "hunk-header") return "hunk-header"
  if (line.kind === "metadata" || line.kind === "no-newline") return "metadata"
  return "plain"
}

export type RenderedDiff = DisplayOffsetMap

/**
 * Display offset to raw offset, one entry per display character plus a terminator. Rebuilt from
 * `segments` rather than accumulated while rendering: it is one number per character - 4.8 million
 * of them on a 4 MB patch - and only a text selection ever reads it, so it is built on demand.
 * Every row's raw text is a segment; the gaps between them are gutters, which carry the raw offset
 * of the row they label.
 */
function buildDisplayToRaw(document: DiffDocument, displayText: string, segments: readonly DisplaySourceSegment[]): readonly number[] {
  const map = new Array<number>(displayText.length + 1)
  let cursor = 0
  for (const segment of segments) {
    for (; cursor < segment.displayStartUtf16; cursor++) map[cursor] = segment.rawStartUtf16
    for (let offset = 0; cursor < segment.displayEndUtf16; cursor++, offset++) map[cursor] = segment.rawStartUtf16 + offset
  }
  for (; cursor <= displayText.length; cursor++) map[cursor] = document.text.length
  return map
}

/**
 * Lays the document out for display: the gutter-prefixed text, the offset maps selection needs,
 * and one paint description per row. Rows are described rather than painted so the pane can
 * colour only what the viewport shows; the whole-document alternative made every install cost
 * grow with the size of the patch. Memoised on the document, which is immutable after parsing.
 */
export function renderDiff(document: DiffDocument): RenderedDiff {
  const cached = document.rendered
  if (cached !== undefined) return cached

  const width = lineNumberWidth(document)
  const segments: DisplaySourceSegment[] = []
  const displayLines: DiffDisplayLine[] = []
  let displayText = ""

  const append = (text: string, rawStart: number, lineIndex: number, source: boolean): void => {
    const displayStartUtf16 = displayText.length
    displayText += text
    if (source) segments.push({ displayStartUtf16, displayEndUtf16: displayText.length, rawStartUtf16: rawStart, rawEndUtf16: rawStart + text.length, lineIndex })
  }

  for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
    const line = document.lines[lineIndex]!
    let prefix = ""
    if (sourceLine(line)) {
      const old = line.oldLine === undefined ? "" : String(line.oldLine)
      const next = line.newLine === undefined ? "" : String(line.newLine)
      prefix = `${old.padStart(width, " ")} ${next.padStart(width, " ")} `
    }
    if (prefix) append(prefix, line.startUtf16, lineIndex, false)
    append(line.raw, line.startUtf16, lineIndex, true)
    // The gutter is spaces and digits, so its column count is its character count.
    displayLines.push({ gutterCols: prefix.length, style: styleFor(line) })
  }
  let displayToRaw: readonly number[] | undefined
  const rendered: RenderedDiff = {
    displayText,
    segments,
    displayLines,
    get displayToRaw(): readonly number[] {
      return displayToRaw ??= buildDisplayToRaw(document, displayText, segments)
    },
  }
  document.rendered = rendered
  return rendered
}

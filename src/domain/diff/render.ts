import { StyledText, cyan, dim, green, red } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import type { DiffDocument, DiffLine, DisplayOffsetMap } from "./document"

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

export type RenderedDiff = DisplayOffsetMap & {
  readonly styledText: StyledText
}

export function renderDiff(document: DiffDocument): RenderedDiff {
  const width = lineNumberWidth(document)
  const chunks: TextChunk[] = []
  const displayToRaw: number[] = []
  const segments: Array<{ displayStartUtf16: number; displayEndUtf16: number; rawStartUtf16: number; rawEndUtf16: number; lineIndex: number }> = []
  let displayText = ""

  const append = (text: string, rawStart: number, lineIndex: number, source: boolean, style: (value: string) => TextChunk) => {
    const displayStartUtf16 = displayText.length
    displayText += text
    for (let offset = 0; offset < text.length; offset++) displayToRaw.push(source ? rawStart + offset : rawStart)
    if (source) segments.push({ displayStartUtf16, displayEndUtf16: displayText.length, rawStartUtf16: rawStart, rawEndUtf16: rawStart + text.length, lineIndex })
    chunks.push(style(text))
  }

  for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
    const line = document.lines[lineIndex]!
    let prefix = ""
    if (sourceLine(line)) {
      const old = line.oldLine === undefined ? "" : String(line.oldLine)
      const next = line.newLine === undefined ? "" : String(line.newLine)
      prefix = `${old.padStart(width, " ")} ${next.padStart(width, " ")} `
    }
    if (prefix) append(prefix, line.startUtf16, lineIndex, false, (value) => dim(value))
    const style = line.kind === "addition" ? green : line.kind === "deletion" ? red : line.kind === "hunk-header" ? cyan : line.kind === "metadata" || line.kind === "no-newline" ? dim : (value: string): TextChunk => ({ __isChunk: true, text: value })
    append(line.raw, line.startUtf16, lineIndex, true, style)
  }
  displayToRaw.push(document.text.length)
  const rendered: RenderedDiff = { styledText: new StyledText(chunks), displayText, displayToRaw, segments }
  document.rendered = rendered
  return rendered
}

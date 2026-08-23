import type { CopyMode, DiffDocument, DiffLine, DisplaySourceSegment } from "./document"

export type NativeSelectionRange = {
  readonly start?: number
  readonly end?: number
  readonly anchor?: number
  readonly focus?: number
  readonly unit?: "utf16" | "utf8"
}

export type DocumentSelection = {
  readonly valid: boolean
  readonly startUtf16: number
  readonly endUtf16: number
  readonly fileIndex?: number
  readonly hunkIndex?: number
  readonly active?: boolean
  readonly reason?: string
}

function nativeBounds(range: NativeSelectionRange): [number, number] {
  const start = range.start ?? range.anchor ?? 0
  const end = range.end ?? range.focus ?? start
  return start <= end ? [start, end] : [end, start]
}

function utf8BoundaryToUtf16(value: string, byteOffset: number): number | undefined {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined
  if (byteOffset === 0) return 0
  let bytes = 0
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset)!
    const width = Buffer.byteLength(String.fromCodePoint(codePoint), "utf8")
    bytes += width
    offset += String.fromCodePoint(codePoint).length
    if (bytes === byteOffset) return offset
    if (bytes > byteOffset) return undefined
  }
  return bytes === byteOffset ? value.length : undefined
}

function selectionFromRaw(document: DiffDocument, startUtf16: number, endUtf16: number): DocumentSelection {
  const line = document.lines.find((entry) => startUtf16 >= entry.startUtf16 && startUtf16 <= entry.endUtf16) ?? document.lines[0]
  const selection: DocumentSelection = { valid: true, startUtf16, endUtf16 }
  if (line) {
    return {
      ...selection,
      fileIndex: line.fileIndex,
      ...(line.hunkIndex === undefined ? {} : { hunkIndex: line.hunkIndex }),
    }
  }
  return selection
}

function mapDisplayRange(document: DiffDocument, start: number, end: number): DocumentSelection | undefined {
  const rendered = document.rendered
  if (!rendered || start < 0 || end < start || end > rendered.displayText.length) return undefined
  if (start === end) {
    const raw = rendered.displayToRaw[start] ?? document.text.length
    return selectionFromRaw(document, raw, raw)
  }
  let rawStart: number | undefined
  let rawEnd: number | undefined
  let lineIndex: number | undefined
  for (const segment of rendered.segments as readonly DisplaySourceSegment[]) {
    const overlapStart = Math.max(start, segment.displayStartUtf16)
    const overlapEnd = Math.min(end, segment.displayEndUtf16)
    if (overlapStart >= overlapEnd) continue
    const candidateStart = segment.rawStartUtf16 + overlapStart - segment.displayStartUtf16
    const candidateEnd = segment.rawStartUtf16 + overlapEnd - segment.displayStartUtf16
    rawStart = rawStart === undefined ? candidateStart : Math.min(rawStart, candidateStart)
    rawEnd = rawEnd === undefined ? candidateEnd : Math.max(rawEnd, candidateEnd)
    lineIndex ??= segment.lineIndex
  }
  if (rawStart === undefined || rawEnd === undefined) return selectionFromRaw(document, rendered.displayToRaw[start] ?? 0, rendered.displayToRaw[end] ?? 0)
  const selection = selectionFromRaw(document, rawStart, rawEnd)
  const line = document.lines[lineIndex ?? 0]
  return line ? { ...selection, fileIndex: line.fileIndex, ...(line.hunkIndex === undefined ? {} : { hunkIndex: line.hunkIndex }) } : selection
}

export function selectionFromRenderable(document: DiffDocument, nativeRange: NativeSelectionRange, selectedText: string): DocumentSelection {
  const [start, end] = nativeBounds(nativeRange)
  const rendered = document.rendered
  const candidates: Array<{ start: number; end: number; value: string; display: boolean }> = []
  if (nativeRange.unit !== "utf8") {
    if (rendered && start <= rendered.displayText.length && end <= rendered.displayText.length) candidates.push({ start, end, value: rendered.displayText.slice(start, end), display: true })
    if (start <= document.text.length && end <= document.text.length) candidates.push({ start, end, value: document.text.slice(start, end), display: false })
  }
  if (nativeRange.unit === "utf8" || candidates.every((candidate) => candidate.value !== selectedText)) {
    const displayValue = rendered?.displayText
    const values = displayValue ? [displayValue, document.text] : [document.text]
    const converted = values.map((value) => [utf8BoundaryToUtf16(value, start), utf8BoundaryToUtf16(value, end)] as const)
    for (let index = 0; index < converted.length; index++) {
      const [convertedStart, convertedEnd] = converted[index]!
      if (convertedStart !== undefined && convertedEnd !== undefined) candidates.push({ start: convertedStart, end: convertedEnd, value: values[index]!.slice(convertedStart, convertedEnd), display: index === 0 && Boolean(displayValue) })
    }
  }
  const match = candidates.find((candidate) => candidate.value === selectedText)
  if (!match) return { valid: false, startUtf16: start, endUtf16: end, active: false, reason: "native/display selection mismatch" }
  if (match.display) {
    const selection = mapDisplayRange(document, match.start, match.end)
    if (selection) return selection
  }
  return selectionFromRaw(document, match.start, match.end)
}

function selectedRange(selection: DocumentSelection | undefined, document: DiffDocument, mode: CopyMode): [number, number] | undefined {
  if (!selection?.valid && mode !== "hunk" && mode !== "file") return undefined
  if (mode === "hunk" || mode === "file") {
    const file = document.files[selection?.fileIndex ?? 0]
    if (!file) return undefined
    if (mode === "file") return [file.startUtf16, file.endUtf16]
    const hunk = file.hunks[selection?.hunkIndex ?? 0]
    return hunk ? [hunk.startUtf16, hunk.endUtf16] : undefined
  }
  if (selection?.active === false) return undefined
  return selection ? [selection.startUtf16, selection.endUtf16] : undefined
}

function selectedLineText(line: DiffLine, selectionStart: number, selectionEnd: number): string {
  const start = Math.max(selectionStart, line.startUtf16)
  const end = Math.min(selectionEnd, line.endUtf16)
  if (start >= end) return ""
  let value = line.raw.slice(start - line.startUtf16, end - line.startUtf16)
  if ((line.kind === "addition" || line.kind === "deletion") && start <= line.startUtf16 && end > line.startUtf16) value = value.slice(1)
  return value
}

export function copySelection(document: DiffDocument, selection: DocumentSelection | undefined, mode: CopyMode): string {
  const range = selectedRange(selection, document, mode)
  if (!range) return ""
  const [start, end] = range
  if (mode === "text" || mode === "patch" || mode === "hunk" || mode === "file") return document.text.slice(start, end)
  const wanted = mode === "added" ? "addition" : "deletion"
  let result = ""
  for (const line of document.lines) {
    if (line.kind !== wanted) continue
    result += selectedLineText(line, start, end)
  }
  return result
}

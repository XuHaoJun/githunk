import type { DiffDocument, DisplaySourceSegment } from "./document"
import type { DocumentSelection, NativeSelectionRange } from "./selection"

export type { NativeSelectionRange } from "./selection"

export type MainSelectionProjectionSegment =
  | {
      readonly kind: "document"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
      readonly rawStartUtf16: number
      readonly rawEndUtf16: number
      readonly lineIndex: number
    }
  | {
      readonly kind: "text"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
    }
  | {
      readonly kind: "decoration"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
    }

export type MainSelectionProjection = {
  readonly generation: number
  readonly text: string
  readonly segments: readonly MainSelectionProjectionSegment[]
  readonly document?: DiffDocument
}

export type MainSelection = { readonly valid: true; readonly kind: "document"; readonly selection: DocumentSelection } | { readonly valid: true; readonly kind: "text"; readonly text: string } | { readonly valid: false; readonly reason: "native/display selection mismatch" }

const mismatch: MainSelection = { valid: false, reason: "native/display selection mismatch" }

type Utf16Range = readonly [start: number, end: number]

function nativeBounds(range: NativeSelectionRange): Utf16Range {
  const start = range.start ?? range.anchor ?? 0
  const end = range.end ?? range.focus ?? start
  return start <= end ? [start, end] : [end, start]
}

function utf8BoundaryToUtf16(value: string, byteOffset: number): number | undefined {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined
  if (byteOffset === 0) return 0
  let bytes = 0
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset)
    if (codePoint === undefined) return undefined
    const character = String.fromCodePoint(codePoint)
    bytes += Buffer.byteLength(character, "utf8")
    offset += character.length
    if (bytes === byteOffset) return offset
    if (bytes > byteOffset) return undefined
  }
  return bytes === byteOffset ? value.length : undefined
}

function validUtf16Range(value: string, range: Utf16Range, selectedText: string): boolean {
  const [start, end] = range
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= value.length && value.slice(start, end) === selectedText
}

function normalizeRange(projectionText: string, nativeRange: NativeSelectionRange, selectedText: string): Utf16Range | undefined {
  const [start, end] = nativeBounds(nativeRange)
  const candidates: Utf16Range[] = []
  if (nativeRange.unit !== "utf8") candidates.push([start, end])
  if (nativeRange.unit === "utf8" || candidates.every((candidate) => !validUtf16Range(projectionText, candidate, selectedText))) {
    const convertedStart = utf8BoundaryToUtf16(projectionText, start)
    const convertedEnd = utf8BoundaryToUtf16(projectionText, end)
    if (convertedStart !== undefined && convertedEnd !== undefined) candidates.push([convertedStart, convertedEnd])
  }
  return candidates.find((candidate) => validUtf16Range(projectionText, candidate, selectedText))
}

function documentSelection(document: DiffDocument, startUtf16: number, endUtf16: number, lineIndex: number): DocumentSelection {
  const line = document.lines[lineIndex]
  const selection: DocumentSelection = { valid: true, startUtf16, endUtf16 }
  if (!line) return selection
  return {
    ...selection,
    fileIndex: line.fileIndex,
    ...(line.hunkIndex === undefined ? {} : { hunkIndex: line.hunkIndex })
  }
}

export function resolveMainSelection(projection: MainSelectionProjection, nativeRange: NativeSelectionRange, selectedText: string): MainSelection {
  const range = normalizeRange(projection.text, nativeRange, selectedText)
  if (range === undefined) return mismatch

  const [start, end] = range
  let rawStart: number | undefined
  let rawEnd: number | undefined
  let lineIndex: number | undefined

  for (const segment of projection.segments) {
    const overlapStart = Math.max(start, segment.displayStartUtf16)
    const overlapEnd = Math.min(end, segment.displayEndUtf16)
    if (overlapStart >= overlapEnd) continue
    if (segment.kind === "text") return { valid: true, kind: "text", text: selectedText }
    if (segment.kind !== "document") continue

    const segmentRawStart = overlapStart === segment.displayStartUtf16 ? segment.rawStartUtf16 : segment.rawStartUtf16 + overlapStart - segment.displayStartUtf16
    const segmentRawEnd = overlapEnd === segment.displayEndUtf16 ? segment.rawEndUtf16 : segment.rawStartUtf16 + overlapEnd - segment.displayStartUtf16
    rawStart = rawStart === undefined ? segmentRawStart : Math.min(rawStart, segmentRawStart)
    rawEnd = rawEnd === undefined ? segmentRawEnd : Math.max(rawEnd, segmentRawEnd)
    lineIndex ??= segment.lineIndex
  }

  if (rawStart === undefined || rawEnd === undefined || lineIndex === undefined || projection.document === undefined) return mismatch
  return {
    valid: true,
    kind: "document",
    selection: documentSelection(projection.document, rawStart, rawEnd, lineIndex)
  }
}

export function textSelectionProjection(generation: number, text: string): MainSelectionProjection {
  return {
    generation,
    text,
    segments: text.length === 0 ? [] : [{ kind: "text", displayStartUtf16: 0, displayEndUtf16: text.length }]
  }
}

function assertRange(label: string, start: number, end: number, limit: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > limit) {
    throw new RangeError(`invalid ${label} range`)
  }
}

export function eagerDiffSelectionProjection(input: { readonly generation: number; readonly document: DiffDocument; readonly text: string; readonly preambleLength: number; readonly bodySegments: readonly DisplaySourceSegment[] }): MainSelectionProjection {
  const { generation, document, text, preambleLength, bodySegments } = input
  assertRange("preamble", 0, preambleLength, text.length)
  const bodyLength = text.length - preambleLength
  const segments: MainSelectionProjectionSegment[] = []
  if (preambleLength > 0) segments.push({ kind: "text", displayStartUtf16: 0, displayEndUtf16: preambleLength })

  let bodyCursor = 0
  for (const source of bodySegments) {
    assertRange("display", source.displayStartUtf16, source.displayEndUtf16, bodyLength)
    assertRange("raw", source.rawStartUtf16, source.rawEndUtf16, document.text.length)
    if (source.displayStartUtf16 < bodyCursor) throw new RangeError("display segments must be ordered and non-overlapping")
    if (source.displayStartUtf16 > bodyCursor) {
      segments.push({
        kind: "decoration",
        displayStartUtf16: preambleLength + bodyCursor,
        displayEndUtf16: preambleLength + source.displayStartUtf16
      })
    }
    if (source.displayEndUtf16 > source.displayStartUtf16) {
      segments.push({
        kind: "document",
        displayStartUtf16: preambleLength + source.displayStartUtf16,
        displayEndUtf16: preambleLength + source.displayEndUtf16,
        rawStartUtf16: source.rawStartUtf16,
        rawEndUtf16: source.rawEndUtf16,
        lineIndex: source.lineIndex
      })
    }
    bodyCursor = source.displayEndUtf16
  }
  if (bodyCursor < bodyLength) {
    segments.push({
      kind: "decoration",
      displayStartUtf16: preambleLength + bodyCursor,
      displayEndUtf16: text.length
    })
  }

  return { generation, document, text, segments }
}

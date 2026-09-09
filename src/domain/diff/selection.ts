import type { CopyMode, DiffDocument, DiffLine } from "./document"

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




function selectedRange(selection: DocumentSelection | undefined, document: DiffDocument, mode: CopyMode): [number, number] | undefined {
  if (!selection?.valid) return undefined
  if (mode === "hunk" || mode === "file") {
    const file = document.files[selection.fileIndex ?? -1]
    if (!file) return undefined
    if (mode === "file") return [file.startUtf16, file.endUtf16]
    const hunk = file.hunks[selection.hunkIndex ?? -1]
    return hunk ? [hunk.startUtf16, hunk.endUtf16] : undefined
  }
  if (selection.active === false) return undefined
  return [selection.startUtf16, selection.endUtf16]
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

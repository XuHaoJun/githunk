import type { DiffDocument, DiffFile, DiffHunk, DiffLine } from "./document"

export type PartialPatchOptions = {
  readonly reverse: boolean
  readonly wholeFile: boolean
  readonly pathOverride?: string
}

type TransformedHunk = {
  readonly text: string
  readonly oldLength: number
  readonly newLength: number
  readonly hasChanges: boolean
}

function lineValue(raw: string): string {
  return raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") || raw.endsWith("\r") ? raw.slice(0, -1) : raw
}

function lineEnding(raw: string): string {
  if (raw.endsWith("\r\n")) return "\r\n"
  if (raw.endsWith("\n")) return "\n"
  if (raw.endsWith("\r")) return "\r"
  return ""
}

function quotedToken(token: string): string {
  if (![...token].some((character) => character < " " || character > "~" || character === "\"" || character === "\\")) return token
  const bytes = new TextEncoder().encode(token)
  let escaped = "\""
  for (const byte of bytes) {
    if (byte === 0x5c) escaped += "\\\\"
    else if (byte === 0x22) escaped += "\\\""
    else if (byte >= 0x20 && byte <= 0x7e) escaped += String.fromCharCode(byte)
    else escaped += `\\${byte.toString(8).padStart(3, "0")}`
  }
  return `${escaped}\"`
}

function pathForHeader(path: string): string {
  return quotedToken(path.startsWith("/") ? path : `a/${path}`)
}

function pathForNewHeader(path: string): string {
  return quotedToken(path.startsWith("/") ? path : `b/${path}`)
}

function rewriteHeader(lines: readonly DiffLine[], file: DiffFile, options: PartialPatchOptions, partial: boolean): string {
  const path = options.pathOverride
    ?? (file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath)
  const stripRename = partial
    && file.oldPath !== undefined && file.newPath !== undefined
    && file.oldPath !== "/dev/null" && file.newPath !== "/dev/null"
    && file.oldPath !== file.newPath
  const deletedFilePartial = partial && file.oldPath !== undefined && file.newPath === "/dev/null"
  if (!options.pathOverride && !stripRename && !deletedFilePartial) return lines.map((line) => line.raw).join("")
  const result: string[] = []
  for (const line of lines) {
    const value = lineValue(line.raw)
    if ((stripRename && (/^(?:similarity|dissimilarity) index /.test(value) || value.startsWith("rename from ") || value.startsWith("rename to ")))
      || (deletedFilePartial && value.startsWith("deleted file mode "))) continue
    if (path !== undefined && value.startsWith("diff --git ")) {
      result.push(`diff --git ${pathForHeader(path)} ${pathForNewHeader(path)}${lineEnding(line.raw)}`)
      continue
    }
    if (deletedFilePartial && value === "+++ /dev/null" && file.oldPath !== undefined) {
      result.push(`+++ ${pathForNewHeader(file.oldPath)}${lineEnding(line.raw)}`)
      continue
    }
    if (path !== undefined && value.startsWith("--- ") && !value.startsWith("--- /dev/null")) {
      result.push(`--- ${pathForHeader(path)}${lineEnding(line.raw)}`)
      continue
    }
    if (path !== undefined && value.startsWith("+++ ") && !value.startsWith("+++ /dev/null")) {
      result.push(`+++ ${pathForNewHeader(path)}${lineEnding(line.raw)}`)
      continue
    }
    if (stripRename && value.startsWith("--- ") && file.newPath !== undefined) {
      result.push(`--- ${pathForHeader(file.newPath)}${lineEnding(line.raw)}`)
      continue
    }
    result.push(line.raw)
  }
  return result.join("")
}

function hunkHeader(raw: string, oldStart: number, oldLength: number, newStart: number, newLength: number): string {
  const value = lineValue(raw)
  const match = value.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/)
  const context = match?.[1] ?? ""
  const ending = lineEnding(raw)
  const newCount = newLength === 1 ? "" : `,${newLength}`
  return `@@ -${oldStart},${oldLength} +${newStart}${newCount} @@${context}${ending}`
}

function globalLineIndex(document: DiffDocument, line: DiffLine): number {
  return document.lines.indexOf(line)
}

function transformHunk(
  document: DiffDocument,
  hunk: DiffHunk,
  included: ReadonlySet<number>,
  options: PartialPatchOptions,
  startOffset: number,
): TransformedHunk & { readonly nextOffset: number; readonly newStart: number } {
  const pendingContext: string[] = []
  const output: string[] = []
  let didSeeUnselectedNewFileLine = false
  let previousSourceIncluded = false
  let hasChanges = false
  const flush = () => {
    output.push(...pendingContext.splice(0))
  }
  for (const line of hunk.lines) {
    const index = globalLineIndex(document, line)
    const selected = options.wholeFile || included.has(index)
    if (line.kind === "context") {
      flush()
      didSeeUnselectedNewFileLine = false
      output.push(line.raw)
      previousSourceIncluded = true
      continue
    }
    if (line.kind === "no-newline") {
      if (previousSourceIncluded) {
        flush()
        output.push(line.raw)
      }
      continue
    }
    if (line.kind !== "addition" && line.kind !== "deletion") continue
    const isOldFileLine = options.reverse ? line.kind === "addition" : line.kind === "deletion"
    if (selected) {
      if (isOldFileLine || didSeeUnselectedNewFileLine) flush()
      output.push(line.raw)
      previousSourceIncluded = true
      hasChanges = true
      continue
    }
    if (isOldFileLine) {
      pendingContext.push(` ${line.raw.slice(1)}`)
      previousSourceIncluded = true
    } else {
      didSeeUnselectedNewFileLine = true
      previousSourceIncluded = false
    }
  }
  flush()

  const oldLength = output.reduce((count, raw) => count + (raw.startsWith(" ") || raw.startsWith("-") ? 1 : 0), 0)
  const newLength = output.reduce((count, raw) => count + (raw.startsWith(" ") || raw.startsWith("+") ? 1 : 0), 0)
  const newStartOffset = oldLength === 0 ? 1 : newLength === 0 ? -1 : 0
  const newStart = hunk.oldStart + startOffset + newStartOffset
  const nextOffset = startOffset + newLength - oldLength
  const header = hunkHeader(hunk.header.raw, hunk.oldStart, oldLength, newStart, newLength)
  return { text: header + output.join(""), oldLength, newLength, hasChanges, nextOffset, newStart }
}

function fileText(document: DiffDocument, file: DiffFile): string {
  return document.text.slice(file.startUtf16, file.endUtf16)
}

export function buildPartialPatch(
  document: DiffDocument,
  includedLineIndexes: readonly number[],
  options: PartialPatchOptions,
): string {
  const included = new Set(includedLineIndexes)
  const output: string[] = []
  for (const file of document.files) {
    const hunkHeaderLine = file.lines.find((line) => line.kind === "hunk-header")
    const hasSelectedChange = options.wholeFile || file.hunks.some((hunk) => hunk.lines.some((line) =>
      (line.kind === "addition" || line.kind === "deletion") && included.has(globalLineIndex(document, line)),
    ))
    if (!hasSelectedChange) continue
    if (options.wholeFile && options.pathOverride === undefined) {
      output.push(fileText(document, file))
      continue
    }

    const headerLines = hunkHeaderLine ? file.lines.slice(0, file.lines.indexOf(hunkHeaderLine)) : file.lines
    const partial = !options.wholeFile
    output.push(rewriteHeader(headerLines, file, options, partial))
    let startOffset = 0
    for (const hunk of file.hunks) {
      const transformed = transformHunk(document, hunk, included, options, startOffset)
      startOffset = transformed.nextOffset
      if (transformed.hasChanges) output.push(transformed.text)
    }
  }
  return output.join("")
}

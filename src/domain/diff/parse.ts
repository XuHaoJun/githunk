import type { DiffDocument, DiffFile, DiffHunk, DiffLine, DiffLineKind } from "./document"

function withoutLineEnding(raw: string): string {
  return raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") || raw.endsWith("\r") ? raw.slice(0, -1) : raw
}

function pathFromHeader(value: string): string | undefined {
  const path = value.replace(/^(?:a|b)\//, "").replace(/^\/dev\/null$/, "/dev/null")
  return path.split(/[\t ](?=\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/, 1)[0]
}

function decodeGitQuoted(value: string): string {
  return value.replace(/\\([\\"])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n")
}

function stripGitPrefix(value: string): string {
  return decodeGitQuoted(value).replace(/^(?:a|b)\//, "")
}

function splitGitPaths(value: string): [string | undefined, string | undefined] {
  const body = value.slice("diff --git ".length)
  if (body.startsWith("\"")) {
    const firstEnd = body.indexOf("\" ", 1)
    if (firstEnd >= 0) {
      const first = body.slice(1, firstEnd)
      const second = body.slice(firstEnd + 2).trim()
      return [stripGitPrefix(first), stripGitPrefix(second.replace(/^"|"$/g, ""))]
    }
  }
  const candidates = [...body.matchAll(/ b\//g)].map((match) => match.index ?? -1).filter((index) => index >= 0)
  // Git quotes ambiguous old paths; for unquoted records the first ` b/` is the separator.
  const splitAt = candidates[0] ?? -1
  if (splitAt < 0) return [undefined, undefined]
  return [stripGitPrefix(body.slice(0, splitAt)), stripGitPrefix(body.slice(splitAt + 1))]
}

function hunkNumbers(value: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined {
  const match = value.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return undefined
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  }
}

export function parseDiff(text: string): DiffDocument {
  const lines: DiffLine[] = []
  const files: Array<DiffFile & { lines: DiffLine[]; hunks: DiffHunk[] }> = []
  let currentFile: (DiffFile & { lines: DiffLine[]; hunks: DiffHunk[] }) | undefined
  let currentHunk: (DiffHunk & { lines: DiffLine[] }) | undefined
  let oldLine = 0
  let newLine = 0
  let cursor = 0

  const ensureFile = (startUtf16: number): DiffFile & { lines: DiffLine[]; hunks: DiffHunk[] } => {
    if (currentFile) return currentFile
    const created = { fileIndex: files.length, startUtf16, endUtf16: text.length, lines: [], hunks: [] }
    files.push(created)
    currentFile = created
    return created
  }

  const closeHunk = (endUtf16: number) => {
    if (currentHunk) currentHunk.endUtf16 = endUtf16
    currentHunk = undefined
  }

  const closeFile = (endUtf16: number) => {
    closeHunk(endUtf16)
    if (currentFile) currentFile.endUtf16 = endUtf16
    currentFile = undefined
  }

  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor)
    const endUtf16 = newline < 0 ? text.length : newline + 1
    const raw = text.slice(cursor, endUtf16)
    const value = withoutLineEnding(raw)
    const startsFile = value.startsWith("diff --git ")
    if (startsFile) {
      closeFile(cursor)
      const [oldPath, newPath] = splitGitPaths(value)
      const created: DiffFile & { lines: DiffLine[]; hunks: DiffHunk[] } = { fileIndex: files.length, oldPath, newPath, startUtf16: cursor, endUtf16: text.length, lines: [], hunks: [] }
      currentFile = created
      files.push(created)
    }

    const file = ensureFile(cursor)
    let kind: DiffLineKind = "metadata"
    let hunkIndex: number | undefined
    let lineOld: number | undefined
    let lineNew: number | undefined
    const hunk = hunkNumbers(value)

    if (hunk) {
      closeHunk(cursor)
      hunkIndex = file.hunks.length
      const header: DiffLine = { kind: "hunk-header", raw, startUtf16: cursor, endUtf16, fileIndex: file.fileIndex, hunkIndex }
      lines.push(header)
      file.lines.push(header)
      currentHunk = {
        fileIndex: file.fileIndex,
        hunkIndex,
        header,
        startUtf16: cursor,
        endUtf16: text.length,
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
        lines: [],
      }
      file.hunks.push(currentHunk)
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      cursor = endUtf16
      continue
    }
    if (currentHunk && value.startsWith("+")) {
      kind = "addition"
      hunkIndex = currentHunk.hunkIndex
      lineNew = newLine++
    } else if (currentHunk && value.startsWith("-")) {
      kind = "deletion"
      hunkIndex = currentHunk.hunkIndex
      lineOld = oldLine++
    } else if (currentHunk && value.startsWith(" ")) {
      kind = "context"
      hunkIndex = currentHunk.hunkIndex
      lineOld = oldLine++
      lineNew = newLine++
    } else if (startsFile || value.startsWith("--- ") || value.startsWith("+++ ")) {
      kind = "file-header"
      if (value.startsWith("--- ")) file.oldPath = pathFromHeader(value.slice(4))
      if (value.startsWith("+++ ")) file.newPath = pathFromHeader(value.slice(4))
    } else if (value.startsWith("\\ No newline at end of file")) {
      kind = "no-newline"
      hunkIndex = currentHunk?.hunkIndex
    }

    const line: DiffLine = {
      kind,
      raw,
      startUtf16: cursor,
      endUtf16,
      fileIndex: file.fileIndex,
      ...(hunkIndex === undefined ? {} : { hunkIndex }),
      ...(lineOld === undefined ? {} : { oldLine: lineOld }),
      ...(lineNew === undefined ? {} : { newLine: lineNew }),
    }
    lines.push(line)
    file.lines.push(line)
    if (currentHunk && hunkIndex === currentHunk.hunkIndex) currentHunk.lines.push(line)
    cursor = endUtf16
  }

  closeFile(text.length)
  return { text, lines, files }
}

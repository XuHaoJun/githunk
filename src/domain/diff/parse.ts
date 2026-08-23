import type { DiffDocument, DiffFile, DiffHunk, DiffLine, DiffLineKind } from "./document"

function withoutLineEnding(raw: string): string {
  return raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") || raw.endsWith("\r") ? raw.slice(0, -1) : raw
}

function pathFromHeader(value: string): string | undefined {
  const path = value.replace(/^(?:a|b)\//, "").replace(/^\/dev\/null$/, "/dev/null").split(/[\t ](?=\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/, 1)[0]!
  return stripGitPrefix(path)
}

function decodeGitQuoted(value: string): string {
  let result = ""
  let bytes: number[] = []
  const flush = () => {
    if (bytes.length > 0) {
      result += new TextDecoder().decode(new Uint8Array(bytes))
      bytes = []
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && /^[0-7]{3}$/.test(value.slice(index + 1, index + 4))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 4), 8))
      index += 3
      continue
    }
    flush()
    if (value[index] === "\\" && (value[index + 1] === "\\" || value[index + 1] === "\"")) {
      result += value[index + 1]
      index += 1
    } else if (value[index] === "\\" && value[index + 1] === "t") {
      result += "\t"
      index += 1
    } else if (value[index] === "\\" && value[index + 1] === "n") {
      result += "\n"
      index += 1
    } else {
      result += value[index]
    }
  }
  flush()
  return result
}

function stripGitPrefix(value: string): string {
  const token = value.trim()
  const unquoted = token.startsWith("\"") && token.endsWith("\"") ? token.slice(1, -1) : token
  return decodeGitQuoted(unquoted).replace(/^(?:a|b)\//, "")
}

function quotedTokenEnd(value: string): number | undefined {
  if (!value.startsWith("\"")) return undefined
  let escaped = false
  for (let index = 1; index < value.length; index++) {
    const character = value[index]!
    if (escaped) {
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (character === "\"") {
      return index
    }
  }
  return undefined
}

function splitGitPaths(value: string): [string | undefined, string | undefined] {
  const body = value.slice("diff --git ".length)
  const firstEnd = quotedTokenEnd(body)
  if (firstEnd !== undefined && body[firstEnd + 1] === " ") {
    const second = body.slice(firstEnd + 2).trim()
    const secondEnd = quotedTokenEnd(second)
    return [
      stripGitPrefix(body.slice(1, firstEnd)),
      stripGitPrefix(secondEnd === undefined ? second : second.slice(1, secondEnd)),
    ]
  }
  const candidates = [...body.matchAll(/ b\//g)].map((match) => match.index ?? -1).filter((index) => index >= 0)
  // Git quotes ambiguous old paths; for unquoted records the first ` b/` is the separator.
  const splitAt = candidates[0] ?? -1
  if (splitAt < 0) return [undefined, undefined]
  return [stripGitPrefix(body.slice(0, splitAt)), stripGitPrefix(body.slice(splitAt + 1))]
}

function splitBinaryPaths(value: string, expectedNewPath: string | undefined): [string | undefined, string | undefined] | undefined {
  if (!value.startsWith("Binary files ") || !value.endsWith(" differ")) return undefined
  const body = value.slice("Binary files ".length, -" differ".length)
  const candidates = [...body.matchAll(/ and (?=(?:"?b\/|\/dev\/null))/g)].map((match) => match.index ?? -1).filter((index) => index >= 0)
  const pairs = candidates.map((splitAt) => [
    stripGitPrefix(body.slice(0, splitAt)),
    stripGitPrefix(body.slice(splitAt + " and ".length)),
  ] as [string | undefined, string | undefined])
  if (pairs.length === 0) return undefined
  if (expectedNewPath !== undefined) {
    const matching = pairs.find((pair) => pair[1] === expectedNewPath)
    if (matching) return matching
  }
  return pairs.length === 1 ? pairs[0] : undefined
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
    } else if (value.startsWith("Binary files ")) {
      const pair = splitBinaryPaths(value, file.newPath)
      if (pair) {
        file.oldPath = pair[0]
        file.newPath = pair[1]
      } else {
        file.oldPath = undefined
        file.newPath = undefined
      }
    } else if (value.startsWith("rename from ")) {
      file.oldPath = pathFromHeader(value.slice("rename from ".length))
    } else if (value.startsWith("rename to ")) {
      file.newPath = pathFromHeader(value.slice("rename to ".length))
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

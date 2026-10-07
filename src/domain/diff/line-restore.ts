import type { DiffDocument, DiffLine } from "./document"

/**
 * Where a diff line is, in terms that survive the diff being rendered again: lazygit's
 * `patch.LineIdentity` (pkg/commands/patch/patch_builder.go:400-430). An addition or context line
 * is named by its line in the new file, a deletion by its line in the old one, so the same line is
 * found again however the rows around it moved.
 */
export type DiffLineIdentity = {
  readonly path: string
  readonly kind: "addition" | "deletion" | "context"
  readonly line: number
}

function isChange(line: DiffLine): boolean {
  return line.kind === "addition" || line.kind === "deletion"
}

/**
 * How many change lines come before `index` — its place in the sequence of changes. An action
 * consumes the lines it acted on, so their identity is gone afterwards, but the place they left is
 * where the next change moves up to (lazygit `ChangeLineOrdinal`,
 * pkg/gui/controllers/helpers/diff_line_restore.go:268-288).
 */
export function changeOrdinalBefore(document: DiffDocument, index: number): number {
  let ordinal = 0
  const end = Math.min(index, document.lines.length)
  for (let current = 0; current < end; current += 1) {
    if (isChange(document.lines[current]!)) ordinal += 1
  }
  return ordinal
}

/**
 * The change line at `ordinal`, or the last change when the diff now has fewer — the changes acted
 * on were its last (lazygit `RevealChangeLineAtOrdinal`, diff_line_restore.go:290-330).
 */
export function changeLineAtOrdinal(document: DiffDocument, ordinal: number): number | undefined {
  let seen = 0
  let last: number | undefined
  for (let index = 0; index < document.lines.length; index += 1) {
    if (!isChange(document.lines[index]!)) continue
    if (seen === ordinal) return index
    seen += 1
    last = index
  }
  return last
}

function filePath(document: DiffDocument, fileIndex: number): string | undefined {
  const file = document.files[fileIndex]
  if (file === undefined) return undefined
  return file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
}

export function diffLineIdentity(document: DiffDocument, index: number): DiffLineIdentity | undefined {
  const line = document.lines[index]
  if (line === undefined) return undefined
  const path = filePath(document, line.fileIndex)
  if (path === undefined) return undefined
  if (line.kind === "deletion") return line.oldLine === undefined ? undefined : { path, kind: "deletion", line: line.oldLine }
  if (line.kind === "addition" || line.kind === "context") return line.newLine === undefined ? undefined : { path, kind: line.kind, line: line.newLine }
  return undefined
}

export function findDiffLineByIdentity(document: DiffDocument, identity: DiffLineIdentity): number | undefined {
  for (let index = 0; index < document.lines.length; index += 1) {
    const line = document.lines[index]!
    if (line.kind !== identity.kind) continue
    if ((identity.kind === "deletion" ? line.oldLine : line.newLine) !== identity.line) continue
    if (filePath(document, line.fileIndex) === identity.path) return index
  }
  return undefined
}

/**
 * The line of the new file a diff row points at, for opening an editor there: an addition's or
 * context line's own new line, the position a deletion sits at, a hunk header's first line
 * (lazygit's `DiffLineInfo.NewLine`, pkg/gui/types/diff_line_info.go:29-32). Undefined for a
 * file header and other rows outside a hunk, which point at the file as a whole.
 */
export function newFilePosition(document: DiffDocument, index: number): number | undefined {
  const line = document.lines[index]
  if (line === undefined || line.hunkIndex === undefined) return undefined
  if (line.newLine !== undefined) return line.newLine
  const hunk = document.files[line.fileIndex]?.hunks[line.hunkIndex]
  if (hunk === undefined) return undefined
  if (line.kind === "hunk-header") return hunk.newStart
  const position = hunk.lines.indexOf(line)
  for (let next = position + 1; next < hunk.lines.length; next += 1) {
    const newLine = hunk.lines[next]!.newLine
    if (newLine !== undefined) return newLine
  }
  for (let previous = position - 1; previous >= 0; previous -= 1) {
    const newLine = hunk.lines[previous]!.newLine
    if (newLine !== undefined) return newLine + 1
  }
  return hunk.newStart
}

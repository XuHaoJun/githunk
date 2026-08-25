export type DiffLineKind =
  | "file-header"
  | "hunk-header"
  | "context"
  | "addition"
  | "deletion"
  | "metadata"
  | "no-newline"

export type DiffLine = {
  readonly kind: DiffLineKind
  readonly raw: string
  readonly startUtf16: number
  readonly endUtf16: number
  readonly fileIndex: number
  readonly hunkIndex?: number
  readonly oldLine?: number
  readonly newLine?: number
}

export type DiffHunk = {
  readonly fileIndex: number
  readonly hunkIndex: number
  readonly header: DiffLine
  readonly startUtf16: number
  endUtf16: number
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: DiffLine[]
}

export type DiffFile = {
  readonly fileIndex: number
  oldPath?: string | undefined
  newPath?: string | undefined
  readonly startUtf16: number
  endUtf16: number
  readonly lines: DiffLine[]
  readonly hunks: DiffHunk[]
}

export type DisplaySourceSegment = {
  readonly displayStartUtf16: number
  readonly displayEndUtf16: number
  readonly rawStartUtf16: number
  readonly rawEndUtf16: number
  readonly lineIndex: number
}

export type DiffDisplayLineStyle = "plain" | "addition" | "deletion" | "hunk-header" | "metadata"

/**
 * How one rendered row is painted: a dim line-number gutter `gutterCols` columns wide (0 when
 * the line has none), then `style` for the rest of the row. A renderer needs no other input to
 * colour a row, so rows can be painted lazily — only the ones the viewport actually shows.
 */
export type DiffDisplayLine = {
  readonly gutterCols: number
  readonly style: DiffDisplayLineStyle
}

export type DisplayOffsetMap = {
  readonly displayText: string
  readonly displayToRaw: readonly number[]
  readonly segments: readonly DisplaySourceSegment[]
  /** One entry per document line, in display order: `displayText`'s rows. */
  readonly displayLines: readonly DiffDisplayLine[]
}

export type DiffDocument = {
  readonly text: string
  readonly lines: readonly DiffLine[]
  readonly files: readonly DiffFile[]
  /** Populated by renderDiff so selection mapping can use the exact displayed document. */
  rendered?: DisplayOffsetMap
}

export type CopyMode = "text" | "added" | "removed" | "patch" | "hunk" | "file"

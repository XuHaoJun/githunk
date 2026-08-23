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

export type DisplayOffsetMap = {
  readonly displayText: string
  readonly displayToRaw: readonly number[]
  readonly segments: readonly DisplaySourceSegment[]
}

export type DiffDocument = {
  readonly text: string
  readonly lines: readonly DiffLine[]
  readonly files: readonly DiffFile[]
  /** Populated by renderDiff so selection mapping can use the exact displayed document. */
  rendered?: {
    readonly displayText: string
    readonly displayToRaw: readonly number[]
    readonly segments: readonly DisplaySourceSegment[]
  }
}

export type CopyMode = "text" | "added" | "removed" | "patch" | "hunk" | "file"

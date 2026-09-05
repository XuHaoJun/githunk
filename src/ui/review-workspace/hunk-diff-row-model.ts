import type { ReviewState } from "../../review/core/state"
import type { HighlightPayload, HighlightedLine } from "../../review/git/highlight/highlight-payload"
import type { HunkReviewFile } from "./hunk-review-model"

export type HunkRenderSpan = Readonly<{
  text: string
  fg?: string
  bg?: string
}>

export type HunkSplitCell = Readonly<{
  kind: "context" | "addition" | "deletion" | "empty"
  sign: " " | "+" | "-"
  lineNumber?: number
  spans: readonly HunkRenderSpan[]
}>

export type HunkStackCell = Readonly<{
  kind: "context" | "addition" | "deletion"
  sign: " " | "+" | "-"
  oldLineNumber?: number
  newLineNumber?: number
  spans: readonly HunkRenderSpan[]
}>

export type HunkDiffRow =
  | Readonly<{
      type: "hunk-header"
      key: string
      fileKey: string
      hunkIndex: number
      text: string
    }>
  | Readonly<{
      type: "collapsed"
      key: string
      fileKey: string
      hunkIndex: number
      gapId: string
      lineCount: number
      oldRange: readonly [number, number]
      newRange: readonly [number, number]
      expanded: boolean
      text: string
    }>
  | Readonly<{
      type: "feedback"
      key: string
      fileKey: string
      hunkIndex: number
      feedbackId: string
      severity: "comment" | "blocking"
      resolution: "active" | "stale" | "orphaned"
      text: string
    }>
  | Readonly<{
      type: "split-line"
      key: string
      fileKey: string
      hunkIndex: number
      left: HunkSplitCell
      right: HunkSplitCell
      isExpansionRow?: true
      expandedGapKey?: string
    }>
  | Readonly<{
      type: "stack-line"
      key: string
      fileKey: string
      hunkIndex: number
      cell: HunkStackCell
      isExpansionRow?: true
      expandedGapKey?: string
    }>
export type HunkDiffAddress = Readonly<{
  fileKey: string
  hunkIndex: number
  side: "old" | "new"
  line: number
}>

/**
 * Return the source locations represented by a rendered row.
 *
 * Split rows retain both sides so the renderer can resolve the actual cell
 * that received a click. Stack rows may contain both line numbers (context),
 * and callers should prefer the new side for a single stack-row selection.
 * Non-source rows and empty split cells intentionally have no addresses.
 */
export function hunkDiffAddresses(row: HunkDiffRow): readonly HunkDiffAddress[] {
  if ((row.type === "split-line" || row.type === "stack-line") && row.isExpansionRow) return []
  if (row.type === "split-line") {
    const addresses: HunkDiffAddress[] = []
    if (row.left.kind !== "empty" && row.left.lineNumber !== undefined) {
      addresses.push({ fileKey: row.fileKey, hunkIndex: row.hunkIndex, side: "old", line: row.left.lineNumber })
    }
    if (row.right.kind !== "empty" && row.right.lineNumber !== undefined) {
      addresses.push({ fileKey: row.fileKey, hunkIndex: row.hunkIndex, side: "new", line: row.right.lineNumber })
    }
    return addresses
  }
  if (row.type === "stack-line") {
    const addresses: HunkDiffAddress[] = []
    if (row.cell.oldLineNumber !== undefined) {
      addresses.push({ fileKey: row.fileKey, hunkIndex: row.hunkIndex, side: "old", line: row.cell.oldLineNumber })
    }
    if (row.cell.newLineNumber !== undefined) {
      addresses.push({ fileKey: row.fileKey, hunkIndex: row.hunkIndex, side: "new", line: row.cell.newLineNumber })
    }
    return addresses
  }
  return []
}

export type HunkRowBuildOptions = Readonly<{
  width: number
  showLineNumbers: boolean
  wrapLines: boolean
  tabWidth?: number
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>
}>

function plainSpans(line: string | undefined): readonly HunkRenderSpan[] {
  return line === undefined ? [] : [{ text: line }]
}

function highlightedSpans(
  line: string | undefined,
  highlighted: HighlightedLine | undefined,
): readonly HunkRenderSpan[] {
  if (highlighted === undefined || highlighted === null) return plainSpans(line)
  if (highlighted.length === 0) return line === undefined ? [] : [{ text: line }]
  return highlighted
}

function splitCell(
  kind: HunkSplitCell["kind"],
  lineNumber: number | undefined,
  line: string | undefined,
  highlighted: HighlightedLine | undefined,
): HunkSplitCell {
  if (kind === "empty") return { kind, sign: " ", spans: [] }
  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    ...(lineNumber === undefined ? {} : { lineNumber }),
    spans: highlightedSpans(line, highlighted),
  }
}

function stackCell(
  kind: HunkStackCell["kind"],
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
  line: string | undefined,
  highlighted: HighlightedLine | undefined,
): HunkStackCell {
  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    ...(oldLineNumber === undefined ? {} : { oldLineNumber }),
    ...(newLineNumber === undefined ? {} : { newLineNumber }),
    spans: highlightedSpans(line, highlighted),
  }
}

function highlightAt(
  highlight: HighlightPayload | undefined,
  side: "deletion" | "addition",
  index: number,
): HighlightedLine | undefined {
  return highlight?.[`${side}Lines`][index]
}

export function hunkHeaderText(file: HunkReviewFile, index: number): string {
  const hunk = file.metadata.hunks[index]
  if (!hunk) return "@@"
  // `hunkSpecs` comes straight from the patch text and keeps its trailing
  // newline; a header is a single row everywhere it is used, so strip it.
  return hunk.hunkSpecs?.replace(/\r?\n$/u, "")
    ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`
}

export function hunkGapBefore(file: HunkReviewFile, hunkIndex: number): { gapId: string; lineCount: number; oldRange: [number, number]; newRange: [number, number] } | null {
  if (hunkIndex <= 0) return null
  const previous = file.metadata.hunks[hunkIndex - 1]
  const current = file.metadata.hunks[hunkIndex]
  if (!previous || !current) return null
  const oldStart = previous.deletionStart + previous.deletionCount
  const newStart = previous.additionStart + previous.additionCount
  const oldEnd = current.deletionStart - 1
  const newEnd = current.additionStart - 1
  const oldCount = oldEnd - oldStart + 1
  const newCount = newEnd - newStart + 1
  const availableCount = oldCount > 0 && newCount > 0 ? Math.min(oldCount, newCount) : Math.max(oldCount, newCount)
  const lineCount = Math.max(0, Math.min(current.collapsedBefore, availableCount))
  return lineCount > 0 ? { gapId: `before:${hunkIndex}`, lineCount, oldRange: [oldStart, oldEnd], newRange: [newStart, newEnd] } : null
}

function gapIsExpanded(state: ReviewState, fileKey: string, gapId: string): boolean {
  return state.expandedGaps.some((gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded)
}

function appendGapRows(
  rows: HunkDiffRow[],
  file: HunkReviewFile,
  state: ReviewState,
  hunkIndex: number,
  mode: "split" | "stack",
  options: HunkRowBuildOptions,
): void {
  const gap = hunkGapBefore(file, hunkIndex)
  if (!gap) return
  const expanded = gapIsExpanded(state, file.id, gap.gapId)
  const source = options.expandedSourceByGap?.get(`${file.id}:${gap.gapId}`)
  if (!expanded || !source) {
    rows.push({
      type: "collapsed",
      key: `${file.id}:${mode}:gap:${gap.gapId}`,
      fileKey: file.id,
      hunkIndex,
      gapId: gap.gapId,
      lineCount: gap.lineCount,
      oldRange: gap.oldRange,
      newRange: gap.newRange,
      expanded,
      text: expanded ? `Loading ${gap.lineCount} unchanged ${gap.lineCount === 1 ? "line" : "lines"} — click to collapse` : `▶ ${gap.lineCount} unchanged ${gap.lineCount === 1 ? "line" : "lines"} — press z or click to expand`,
    })
    return
  }

  const count = Math.min(gap.lineCount, source.length)
  const hasOldSide = file.kind !== "added"
  const hasNewSide = file.kind !== "deleted"
  for (let offset = 0; offset < count; offset += 1) {
    const oldLine = gap.oldRange[0] + offset
    const newLine = gap.newRange[0] + offset
    if (mode === "split") {
      rows.push({
        type: "split-line",
        key: `${file.id}:split:expansion:${gap.gapId}:${offset}`,
        fileKey: file.id,
        hunkIndex,
        isExpansionRow: true,
        expandedGapKey: gap.gapId,
        left: hasOldSide ? splitCell("context", oldLine, source[offset], undefined) : splitCell("empty", undefined, undefined, undefined),
        right: hasNewSide ? splitCell("context", newLine, source[offset], undefined) : splitCell("empty", undefined, undefined, undefined),
      })
    } else {
      rows.push({
        type: "stack-line",
        key: `${file.id}:stack:expansion:${gap.gapId}:${offset}`,
        fileKey: file.id,
        hunkIndex,
        isExpansionRow: true,
        expandedGapKey: gap.gapId,
        cell: stackCell("context", hasOldSide ? oldLine : undefined, hasNewSide ? newLine : undefined, source[offset], undefined),
      })
    }
  }
}

function feedbackAnchorText(file: HunkReviewFile, feedback: ReviewState["feedback"][number]): string {
  if (feedback.anchor.kind === "file") return `${file.path} file`
  const line = feedback.anchor.startLine === feedback.anchor.endLine
    ? `${feedback.anchor.startLine}`
    : `${feedback.anchor.startLine}-${feedback.anchor.endLine}`
  return `${file.path} ${feedback.anchor.side}:${line}`
}

function appendFeedbackRows(rows: HunkDiffRow[], file: HunkReviewFile, state: ReviewState, mode: "split" | "stack"): void {
  for (const feedback of state.feedback) {
    if (feedback.anchor.fileKey !== file.id) continue
    const hunkIndex = feedback.anchor.kind === "range" ? feedback.anchor.ownerHunkIndex : -1
    const body = feedback.body.replace(/\s+/gu, " ").trim()
    const detail = body.length > 0 ? body : "(empty feedback)"
    rows.push({
      type: "feedback",
      key: `${file.id}:${mode}:feedback:${feedback.id}`,
      fileKey: file.id,
      hunkIndex,
      feedbackId: feedback.id,
      severity: feedback.severity,
      resolution: feedback.resolution,
      text: `${feedback.resolution} ${feedback.severity === "blocking" ? "!" : "◆"} ${feedback.kind} — ${detail} — ${feedbackAnchorText(file, feedback)} [e]dit [d]elete [a]nchor`,
    })
  }
}

export function buildHunkSplitRows(
  file: HunkReviewFile,
  state: ReviewState,
  highlight: HighlightPayload | undefined,
  options: HunkRowBuildOptions,
): readonly HunkDiffRow[] {
  const rows: HunkDiffRow[] = []
  const hasOldSide = file.kind !== "added"
  const hasNewSide = file.kind !== "deleted"
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    appendGapRows(rows, file, state, hunkIndex, "split", options)
    rows.push({
      type: "hunk-header",
      key: `${file.id}:split:hunk:${hunkIndex}`,
      fileKey: file.id,
      hunkIndex,
      text: hunkHeaderText(file, hunkIndex),
    })

    let deletionIndex = hunk.deletionLineIndex
    let additionIndex = hunk.additionLineIndex
    let deletionLine = hunk.deletionStart
    let additionLine = hunk.additionStart

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "split-line",
            key: `${file.id}:split:${hunkIndex}:context:${deletionIndex + offset}:${additionIndex + offset}`,
            fileKey: file.id,
            hunkIndex,
            left: hasOldSide ? splitCell("context", deletionLine + offset, file.metadata.deletionLines[deletionIndex + offset], highlightAt(highlight, "deletion", deletionIndex + offset)) : splitCell("empty", undefined, undefined, undefined),
            right: hasNewSide ? splitCell("context", additionLine + offset, file.metadata.additionLines[additionIndex + offset], highlightAt(highlight, "addition", additionIndex + offset)) : splitCell("empty", undefined, undefined, undefined),
          })
        }
        deletionIndex += content.lines
        additionIndex += content.lines
        deletionLine += content.lines
        additionLine += content.lines
        continue
      }

      const pairedLines = Math.max(content.deletions, content.additions)
      for (let offset = 0; offset < pairedLines; offset += 1) {
        const hasDeletion = offset < content.deletions
        const hasAddition = offset < content.additions
        rows.push({
          type: "split-line",
          key: `${file.id}:split:${hunkIndex}:change:${deletionIndex + offset}:${additionIndex + offset}`,
          fileKey: file.id,
          hunkIndex,
          left: hasDeletion ? splitCell("deletion", deletionLine + offset, file.metadata.deletionLines[deletionIndex + offset], highlightAt(highlight, "deletion", deletionIndex + offset)) : splitCell("empty", undefined, undefined, undefined),
          right: hasAddition ? splitCell("addition", additionLine + offset, file.metadata.additionLines[additionIndex + offset], highlightAt(highlight, "addition", additionIndex + offset)) : splitCell("empty", undefined, undefined, undefined),
        })
      }
      deletionIndex += content.deletions
      additionIndex += content.additions
      deletionLine += content.deletions
      additionLine += content.additions
    }
  }
  appendFeedbackRows(rows, file, state, "split")
  return rows
}

export function buildHunkStackRows(
  file: HunkReviewFile,
  state: ReviewState,
  highlight: HighlightPayload | undefined,
  options: HunkRowBuildOptions,
): readonly HunkDiffRow[] {
  const rows: HunkDiffRow[] = []
  const hasOldSide = file.kind !== "added"
  const hasNewSide = file.kind !== "deleted"
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    appendGapRows(rows, file, state, hunkIndex, "stack", options)
    rows.push({
      type: "hunk-header",
      key: `${file.id}:stack:hunk:${hunkIndex}`,
      fileKey: file.id,
      hunkIndex,
      text: hunkHeaderText(file, hunkIndex),
    })

    let deletionIndex = hunk.deletionLineIndex
    let additionIndex = hunk.additionLineIndex
    let deletionLine = hunk.deletionStart
    let additionLine = hunk.additionStart

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "stack-line",
            key: `${file.id}:stack:${hunkIndex}:context:${deletionIndex + offset}:${additionIndex + offset}`,
            fileKey: file.id,
            hunkIndex,
            cell: stackCell("context", hasOldSide ? deletionLine + offset : undefined, hasNewSide ? additionLine + offset : undefined, file.metadata.additionLines[additionIndex + offset] ?? file.metadata.deletionLines[deletionIndex + offset], highlightAt(highlight, "addition", additionIndex + offset) ?? highlightAt(highlight, "deletion", deletionIndex + offset)),
          })
        }
        deletionIndex += content.lines
        additionIndex += content.lines
        deletionLine += content.lines
        additionLine += content.lines
        continue
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:deletion:${deletionIndex + offset}`,
          fileKey: file.id,
          hunkIndex,
          cell: stackCell("deletion", deletionLine + offset, undefined, file.metadata.deletionLines[deletionIndex + offset], highlightAt(highlight, "deletion", deletionIndex + offset)),
        })
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:addition:${additionIndex + offset}`,
          fileKey: file.id,
          hunkIndex,
          cell: stackCell("addition", undefined, additionLine + offset, file.metadata.additionLines[additionIndex + offset], highlightAt(highlight, "addition", additionIndex + offset)),
        })
      }
      deletionIndex += content.deletions
      additionIndex += content.additions
      deletionLine += content.deletions
      additionLine += content.additions
    }
  }
  appendFeedbackRows(rows, file, state, "stack")
  return rows
}

import { useMemo } from "react"
import type { ReviewState } from "../../../review/core/state"
import type { HighlightPayload } from "../../../review/git/highlight/highlight-payload"
import type { HunkReviewFile } from "../hunk-review-model"
import { buildHunkSplitRows, buildHunkStackRows, hunkGapBefore, type HunkDiffRow } from "../hunk-diff-rows"
import { ReviewDiffRow } from "./ReviewDiffRow"

export type ReviewDiffSectionProps = Readonly<{
  file: HunkReviewFile
  state: ReviewState
  layout: "split" | "stack"
  width: number
  selectedHunkIndex: number
  showLineNumbers: boolean
  wrapLines: boolean
  highlight?: HighlightPayload
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>
  rowStart?: number
  rowEnd?: number
  onSelect?: () => void
  onSelectFeedback?: (feedbackId: string) => void
  onSelectDiffRow?: (row: HunkDiffRow) => void
  onToggleGap?: (gapId: string) => void
  selectedFeedbackId?: string | null
}>

function lineDigits(file: HunkReviewFile): number {
  let highest = 1
  for (const hunk of file.metadata.hunks) {
    highest = Math.max(
      highest,
      hunk.deletionStart + hunk.deletionCount,
      hunk.additionStart + hunk.additionCount,
    )
  }
  return String(highest).length
}

function rowsFor(
  file: HunkReviewFile,
  state: ReviewState,
  layout: "split" | "stack",
  width: number,
  showLineNumbers: boolean,
  wrapLines: boolean,
  highlight: HighlightPayload | undefined,
  expandedSourceByGap: ReadonlyMap<string, readonly string[]> | undefined,
): readonly HunkDiffRow[] {
  const options = {
    width,
    showLineNumbers,
    wrapLines,
    ...(expandedSourceByGap ? { expandedSourceByGap } : {}),
  }
  return layout === "split"
    ? buildHunkSplitRows(file, state, highlight, options)
    : buildHunkStackRows(file, state, highlight, options)
}

export function hunkSectionRowCount(
  file: HunkReviewFile,
  layout: "split" | "stack",
  state?: ReviewState,
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>,
): number {
  const feedbackCount = state?.feedback.filter((feedback) => feedback.anchor.fileKey === file.id).length ?? 0
  if (file.kind === "binary" || file.reviewFile.source === "binary" || file.reviewFile.source === "too-large") return 2 + feedbackCount
  let count = 1
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    const gap = hunkGapBefore(file, hunkIndex)
    if (gap) {
      const expanded = state?.expandedGaps.some((entry) => entry.fileKey === file.id && entry.gapId === gap.gapId && entry.expanded) ?? false
      const source = expandedSourceByGap?.get(`${file.id}:${gap.gapId}`)
      count += expanded && source ? Math.min(gap.lineCount, source.length) : 1
    }
    count += 1
    for (const content of hunk.hunkContent) {
      count += content.type === "context"
        ? content.lines
        : layout === "split"
          ? Math.max(content.deletions, content.additions)
          : content.deletions + content.additions
    }
  }
  return count + (file.metadata.hunks.length === 0 ? 1 : 0) + feedbackCount
}

function hunkBodyRowCount(hunk: HunkReviewFile["metadata"]["hunks"][number], layout: "split" | "stack"): number {
  let count = 0
  for (const content of hunk.hunkContent) {
    count += content.type === "context"
      ? content.lines
      : layout === "split"
        ? Math.max(content.deletions, content.additions)
        : content.deletions + content.additions
  }
  return count
}

export function hunkSectionRowOffset(
  file: HunkReviewFile,
  layout: "split" | "stack",
  hunkIndex: number,
  state?: ReviewState,
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>,
): number {
  if (hunkIndex <= 0) return 1
  let offset = 1
  const end = Math.min(hunkIndex, file.metadata.hunks.length)
  for (let index = 0; index < end; index += 1) {
    const gap = hunkGapBefore(file, index)
    if (gap) {
      const expanded = state?.expandedGaps.some((entry) => entry.fileKey === file.id && entry.gapId === gap.gapId && entry.expanded) ?? false
      const source = expandedSourceByGap?.get(`${file.id}:${gap.gapId}`)
      offset += expanded && source ? Math.min(gap.lineCount, source.length) : 1
    }
    const hunk = file.metadata.hunks[index]
    if (hunk) offset += 1 + hunkBodyRowCount(hunk, layout)
  }
  const selectedGap = hunkGapBefore(file, end)
  if (selectedGap) {
    const expanded = state?.expandedGaps.some((entry) => entry.fileKey === file.id && entry.gapId === selectedGap.gapId && entry.expanded) ?? false
    const source = expandedSourceByGap?.get(`${file.id}:${selectedGap.gapId}`)
    offset += expanded && source ? Math.min(selectedGap.lineCount, source.length) : 1
  }
  return offset
}
export function ReviewDiffSection({
  file,
  state,
  layout,
  width,
  selectedHunkIndex,
  showLineNumbers,
  wrapLines,
  highlight,
  expandedSourceByGap,
  rowStart = 0,
  rowEnd,
  onSelect,
  onSelectFeedback,
  onSelectDiffRow,
  onToggleGap,
  selectedFeedbackId,
}: ReviewDiffSectionProps) {
  const rows = useMemo(
    () => rowsFor(file, state, layout, width, showLineNumbers, wrapLines, highlight, expandedSourceByGap),
    [expandedSourceByGap, file, layout, highlight, showLineNumbers, state.expandedGaps, state.feedback, width, wrapLines],
  )
  const digits = lineDigits(file)
  const selectProps = onSelect ? { onMouseUp: () => onSelect() } : {}
  const totalRows = hunkSectionRowCount(file, layout, state, expandedSourceByGap)
  const visibleStart = Math.max(0, Math.min(totalRows, Math.floor(rowStart)))
  const visibleEnd = Math.max(visibleStart, Math.min(totalRows, Math.ceil(rowEnd ?? totalRows)))
  const hasDiffRows = rows.some((row) => row.type !== "feedback")
  const contentRows = hasDiffRows ? rows : rows.filter((row) => row.type === "feedback")
  const visibleContentRows = contentRows.filter((_, index) => {
    const fullIndex = hasDiffRows ? index + 1 : index + 2
    return fullIndex >= visibleStart && fullIndex < visibleEnd
  })
  const showHeader = visibleStart <= 0 && visibleEnd > 0
  const showExplanation = !hasDiffRows && visibleStart <= 1 && visibleEnd > 1
  const renderRow = (row: HunkDiffRow) => {
    const rowClick = row.type === "collapsed" && onToggleGap
      ? () => onToggleGap(row.gapId)
      : row.type === "feedback" && onSelectFeedback
        ? () => onSelectFeedback(row.feedbackId)
        : (row.type === "split-line" || row.type === "stack-line") && onSelectDiffRow
          ? () => onSelectDiffRow(row)
          : row.type === "hunk-header" && row.hunkIndex === selectedHunkIndex
            ? onSelect
            : undefined
    return (
      <ReviewDiffRow
        key={row.key}
        row={row}
        width={width}
        digits={digits}
        showLineNumbers={showLineNumbers}
        selected={row.type === "feedback" ? row.feedbackId === selectedFeedbackId : row.hunkIndex === selectedHunkIndex}
        {...(rowClick ? { onClick: rowClick } : {})}
      />
    )
  }

  return (
    <box id={`review-section:${file.id}`} style={{ width: "100%", height: totalRows, flexShrink: 0, flexDirection: "column" }}>
      {visibleStart > 0 ? <box key="review-section-leading-spacer" style={{ width: "100%", height: visibleStart }} /> : null}
      {showHeader ? (
        <box style={{ width: "100%", height: 1 }} {...selectProps}>
          <text content={file.previousPath ? `${file.path} ← ${file.previousPath}` : file.path} wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {showExplanation ? (
        <text content={file.kind === "binary" || file.reviewFile.source === "binary" ? "Binary file — line rendering unavailable; file-level review remains available." : file.reviewFile.source === "too-large" ? "File too large — line rendering unavailable; file-level review remains available." : "No hunks — file mode change or empty diff."} wrapMode="none" truncate={true} />
      ) : null}
      {visibleContentRows.map(renderRow)}
      {totalRows > visibleEnd ? <box key="review-section-trailing-spacer" style={{ width: "100%", height: totalRows - visibleEnd }} /> : null}
    </box>
  )
}

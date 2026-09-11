import { feedbackRowCountForFile } from "../hunk-diff-row-model"
import type { ReviewReplies } from "../../../review/core/ledger"
import { useMemo } from "react"
import type { ReviewState } from "../../../review/core/state"
import type { HighlightPayload } from "../../../review/git/highlight/highlight-payload"
import type { HunkReviewFile } from "../hunk-review-model"
import { buildHunkSplitRows, buildHunkStackRows, feedbackRowGroups, hunkGapBefore, hunkDiffAddresses, type HunkDiffAddress, type HunkDiffRow } from "../hunk-diff-rows"
import { ReviewDiffRow } from "./ReviewDiffRow"

export type ReviewDiffSectionProps = Readonly<{
  replies?: ReviewReplies
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
  onSelectDiffAddress?: (address: HunkDiffAddress) => void
  onToggleGap?: (gapId: string) => void
  selectedFeedbackId?: string | null
  showDivider: boolean
}>

function lineDigits(file: HunkReviewFile): number {
  let highest = 1
  for (const hunk of file.metadata.hunks) {
    highest = Math.max(highest, hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount)
  }
  return String(highest).length
}

function rowsFor(file: HunkReviewFile, state: ReviewState, layout: "split" | "stack", width: number, showLineNumbers: boolean, wrapLines: boolean, highlight: HighlightPayload | undefined, expandedSourceByGap: ReadonlyMap<string, readonly string[]> | undefined, replies?: ReviewReplies): readonly HunkDiffRow[] {
  const options = {
    width,
    showLineNumbers,
    wrapLines,
    ...(replies ? { replies } : {}),
    ...(expandedSourceByGap ? { expandedSourceByGap } : {})
  }
  return layout === "split" ? buildHunkSplitRows(file, state, highlight, options) : buildHunkStackRows(file, state, highlight, options)
}

export function hunkSectionRowCount(file: HunkReviewFile, layout: "split" | "stack", state?: ReviewState, expandedSourceByGap?: ReadonlyMap<string, readonly string[]>, showDivider = false, replies?: ReviewReplies): number {
  const dividerRows = showDivider ? 1 : 0
  const feedbackCount = state === undefined ? 0 : feedbackRowCountForFile(file, state, layout, replies)
  if (file.kind === "binary" || file.reviewFile.source === "binary" || file.reviewFile.source === "too-large") return dividerRows + 2 + feedbackCount
  let count = dividerRows + 1
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    const gap = hunkGapBefore(file, hunkIndex)
    if (gap) {
      const expanded = state?.expandedGaps.some((entry) => entry.fileKey === file.id && entry.gapId === gap.gapId && entry.expanded) ?? false
      const source = expandedSourceByGap?.get(`${file.id}:${gap.gapId}`)
      count += expanded && source ? Math.min(gap.lineCount, source.length) : 1
    }
    count += 1
    for (const content of hunk.hunkContent) {
      count += content.type === "context" ? content.lines : layout === "split" ? Math.max(content.deletions, content.additions) : content.deletions + content.additions
    }
  }
  return count + (file.metadata.hunks.length === 0 ? 1 : 0) + feedbackCount
}

function hunkBodyRowCount(hunk: HunkReviewFile["metadata"]["hunks"][number], layout: "split" | "stack"): number {
  let count = 0
  for (const content of hunk.hunkContent) {
    count += content.type === "context" ? content.lines : layout === "split" ? Math.max(content.deletions, content.additions) : content.deletions + content.additions
  }
  return count
}
function feedbackRowsBeforeHunk(file: HunkReviewFile, state: ReviewState, layout: "split" | "stack", hunkIndex: number, replies?: ReviewReplies): number {
  let count = 0
  for (const group of feedbackRowGroups(file, state, layout, replies)) {
    const anchor = group.anchor
    if (anchor.kind !== "range") continue
    const ownerIndex = file.metadata.hunks.findIndex((hunk) => {
      const start = anchor.side === "old" ? hunk.deletionStart : hunk.additionStart
      const lineCount = anchor.side === "old" ? hunk.deletionCount : hunk.additionCount
      return lineCount > 0 && anchor.startLine >= start && anchor.endLine < start + lineCount
    })
    if (ownerIndex >= 0 && ownerIndex < hunkIndex) count += group.rows.length
  }
  return count
}

/**
 * The row model appends an objection beneath the source row it names. Hunk
 * headers after that row therefore move down by the whole group, including
 * replies and addressed excerpts.
 */

export function hunkSectionRowOffset(file: HunkReviewFile, layout: "split" | "stack", hunkIndex: number, state?: ReviewState, expandedSourceByGap?: ReadonlyMap<string, readonly string[]>, showDivider = false, replies?: ReviewReplies): number {
  const dividerRows = showDivider ? 1 : 0
  if (hunkIndex <= 0) return dividerRows + 1
  let offset = dividerRows + 1
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
  if (state !== undefined) offset += feedbackRowsBeforeHunk(file, state, layout, hunkIndex, replies)
  return offset
}
/**
 * Where an objection's own row sits inside its file section.
 *
 * Revealing used to aim at the objection's hunk header, which was close enough
 * while objections were collected at the end of a file and is not close enough
 * now that each sits under the line it was written against: a visible hunk
 * header says nothing about whether the objection below it is on screen.
 *
 * Rows come from the same builder the section renders, so the answer cannot
 * disagree with what is drawn. Returns -1 when the file holds no such row.
 */
export function feedbackSectionRowOffset(file: HunkReviewFile, layout: "split" | "stack", feedbackId: string, state: ReviewState, expandedSourceByGap?: ReadonlyMap<string, readonly string[]>, showDivider = false, replies?: ReviewReplies): number {
  const rows = rowsFor(file, state, layout, 120, true, false, undefined, expandedSourceByGap, replies)
  const index = rows.findIndex((row) => row.type === "feedback" && row.feedbackId === feedbackId)
  if (index < 0) return -1
  const hasExplanation = file.metadata.hunks.length === 0 || file.kind === "binary" || file.reviewFile.source === "binary" || file.reviewFile.source === "too-large"
  return (showDivider ? 1 : 0) + (hasExplanation ? 2 : 1) + index
}

export function ReviewDiffSection({ file, state, layout, width, selectedHunkIndex, showLineNumbers, wrapLines, highlight, expandedSourceByGap, rowStart = 0, rowEnd, onSelect, onSelectFeedback, onSelectDiffAddress, onToggleGap, selectedFeedbackId, showDivider, replies }: ReviewDiffSectionProps) {
  const rows = useMemo(() => rowsFor(file, state, layout, width, showLineNumbers, wrapLines, highlight, expandedSourceByGap, replies), [expandedSourceByGap, file, layout, highlight, replies, showLineNumbers, state.expandedGaps, state.feedback, width, wrapLines])
  const digits = lineDigits(file)
  const selectProps = onSelect ? { onMouseUp: () => onSelect() } : {}
  const totalRows = hunkSectionRowCount(file, layout, state, expandedSourceByGap, showDivider, replies)
  const visibleStart = Math.max(0, Math.min(totalRows, Math.floor(rowStart)))
  const visibleEnd = Math.max(visibleStart, Math.min(totalRows, Math.ceil(rowEnd ?? totalRows)))
  const hasDiffRows = rows.some((row) => row.type === "hunk-header" || row.type === "collapsed" || row.type === "split-line" || row.type === "stack-line")
  const sectionChromeRows = showDivider ? 1 : 0
  const contentRows = rows
  const visibleContentRows = contentRows.filter((_, index) => {
    const fullIndex = index + (hasDiffRows ? 1 : 2) + sectionChromeRows
    return fullIndex >= visibleStart && fullIndex < visibleEnd
  })
  const showHeader = visibleStart <= sectionChromeRows && visibleEnd > sectionChromeRows
  const showExplanation = !hasDiffRows && visibleStart <= sectionChromeRows + 1 && visibleEnd > sectionChromeRows + 1
  const renderRow = (row: HunkDiffRow) => {
    const rowClick =
      row.type === "collapsed" && onToggleGap
        ? () => onToggleGap(row.gapId)
        : row.type === "feedback" && onSelectFeedback
          ? () => onSelectFeedback(row.feedbackId)
          : (row.type === "split-line" || row.type === "stack-line") && onSelectDiffAddress
            ? (side?: "old" | "new") => {
                const addresses = hunkDiffAddresses(row)
                const address = row.type === "split-line" ? addresses.find((candidate) => candidate.side === side) : (addresses.find((candidate) => candidate.side === "new") ?? addresses[0])
                if (address) onSelectDiffAddress(address)
              }
            : row.type === "hunk-header" && row.hunkIndex === selectedHunkIndex
              ? onSelect
              : undefined
    const selected =
      row.type === "feedback"
        ? row.feedbackId === selectedFeedbackId
        : row.type === "hunk-header"
          ? row.hunkIndex === selectedHunkIndex
          : (row.type === "split-line" || row.type === "stack-line") && state.lineSelection !== null
            ? hunkDiffAddresses(row).some((address) => address.fileKey === state.lineSelection?.fileKey && address.hunkIndex === state.lineSelection?.hunkIndex && address.side === state.lineSelection?.side && address.line === state.lineSelection?.line)
            : false
    return <ReviewDiffRow key={row.key} row={row} width={width} digits={digits} showLineNumbers={showLineNumbers} selected={selected} {...(rowClick ? { onClick: rowClick } : {})} />
  }

  return (
    <box id={`review-section:${file.id}`} style={{ width, height: totalRows, flexShrink: 0, flexDirection: "column" }}>
      {visibleStart > 0 ? <box key="review-section-leading-spacer" style={{ width: "100%", height: visibleStart }} /> : null}
      {showDivider && visibleStart <= 0 && visibleEnd > 0 ? (
        <box key="review-section-divider" id={`review-section-divider:${file.id}`} style={{ width: "100%", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text content={"─".repeat(Math.max(0, width - 2))} fg="#666666" wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {showHeader ? (
        <box style={{ width: "100%", height: 1 }} {...selectProps}>
          <text content={file.previousPath ? `${file.path} ← ${file.previousPath}` : file.path} wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {showExplanation ? (
        <text
          content={
            file.kind === "binary" || file.reviewFile.source === "binary"
              ? "Binary file — line rendering unavailable; file-level review remains available."
              : file.reviewFile.source === "too-large"
                ? "File too large — line rendering unavailable; file-level review remains available."
                : "No hunks — file mode change or empty diff."
          }
          wrapMode="none"
          truncate={true}
        />
      ) : null}
      {visibleContentRows.map(renderRow)}
      {totalRows > visibleEnd ? <box key="review-section-trailing-spacer" style={{ width: "100%", height: totalRows - visibleEnd }} /> : null}
    </box>
  )
}

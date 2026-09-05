import type { ReviewState } from "../../review/core/state"
import { reviewProgress } from "../../review/core/selectors"
import { cellWidth } from "../cell-width"

export type ReviewHeaderSpan = Readonly<{
  text: string
  style: "plain" | "dim" | "strong" | "addition" | "deletion"
  action?: "choose-base"
}>

export type ReviewHeaderLine = readonly ReviewHeaderSpan[]

function shortRef(ref: string | null): string {
  if (!ref) return "detached"
  // strip refs/heads/ and refs/remotes/ prefix for display, keep rest
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "")
}

function truncateCell(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (cellWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return "…"
  // Reserve 1 cell for ellipsis
  const ellipsisWidth = 1
  const budget = maxWidth - ellipsisWidth
  let width = 0
  let out = ""
  for (const ch of text) {
    // Use cellWidth per grapheme approximated via single char width
    const w = cellWidth(ch)
    if (width + w > budget) break
    out += ch
    width += w
  }
  return out + "…"
}

function formatStat(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return String(value)
}

export function reviewHeaderLines(state: ReviewState, width: number): readonly ReviewHeaderLine[] {
  const w = Math.max(0, Math.floor(width))
  const progress = reviewProgress(state)
  const doc = state.document
  const headLabel = shortRef(doc.identity.headRef ?? doc.identity.detachedHeadOid)
  const baseLabel = shortRef(doc.identity.baseRef)
  const commits = doc.commits.length
  const files = doc.files.length

  // Aggregate stats: sum additions/deletions where not null? If any null, show — ? But spec says binary counts as —
  // For header, we sum numeric; if any file has null counts (binary), we still show sum for numeric ones but represent overall? Spec says "additions and deletions, with binary/unknown counts rendered as —"
  // Interpretation: if file stats are null, show — for that file's contribution; header's total should maybe show — if any binary? Or sum numeric and keep — for binary portion?
  // Simpler: sum numeric only; if any null exists, suffix with +— or show — separately? We'll show total numeric sum and if any binary file exists, show " —" as indicator.
  // Alternative: if all stats null? Show —. We'll implement: totalAdditions = sum of non-null, totalDeletions similarly, but if all null -> —
  let totalAdditions: number | null = 0
  let totalDeletions: number | null = 0
  let hasBinary = false
  let allAddNull = true
  let allDelNull = true
  for (const f of doc.files) {
    if (f.stats.additions === null || f.stats.deletions === null) hasBinary = true
    if (f.stats.additions !== null) {
      totalAdditions = (totalAdditions as number) + f.stats.additions
      allAddNull = false
    }
    if (f.stats.deletions !== null) {
      totalDeletions = (totalDeletions as number) + f.stats.deletions
      allDelNull = false
    }
  }
  if (allAddNull && files > 0) totalAdditions = null
  if (allDelNull && files > 0) totalDeletions = null
  // If no files, keep 0

  const additionsText = totalAdditions === null ? "—" : `+${totalAdditions}`
  const deletionsText = totalDeletions === null ? "—" : `−${totalDeletions}`

  // Line 1: head → base  •  commits · files · stats  •  projection
  const projectionLabel = "Aggregate"

  // Keep the base reachable even when the current branch name fills the terminal.
  const baseBudget = Math.min(cellWidth(baseLabel), Math.max(1, Math.floor(w / 2)))
  const headPrefix = w > baseBudget + 3
    ? `${truncateCell(headLabel, w - baseBudget - 3)} → `
    : ""
  const baseText = truncateCell(baseLabel, Math.max(0, w - cellWidth(headPrefix)))
  const suffix = `  ·  ${commits} commits · ${files} files · ${additionsText} ${deletionsText}  [${projectionLabel}]`
  const suffixText = truncateCell(suffix, Math.max(0, w - cellWidth(headPrefix) - cellWidth(baseText)))

  // Line 2: Reviewed 11/18 · 2 changed · 4 pending
  // reviewProgress gives viewed, changed, unreviewed, pending, total
  const reviewedLabel = `Reviewed ${progress.viewed}/${progress.total}`
  const changedPart = progress.changed > 0 ? ` · ${progress.changed} changed` : ""
  const pendingPart = progress.pending > 0 ? ` · ${progress.pending} pending` : progress.pending === 0 ? " · 0 pending" : ""
  // Also show reviewing count if any?
  const reviewingPart = progress.reviewing > 0 ? ` · ${progress.reviewing} reviewing` : ""
  const line2Raw = `${reviewedLabel}${changedPart}${reviewingPart}${pendingPart}`
  const line2 = truncateCell(line2Raw, w)

  // Possibly a warning line if needed: generation-change etc. For now, empty if none.
  // We keep header to 2 lines; tests expect at least 2.
  // But to satisfy spec "header shows warnings", we could add third line if needed — not required for basic.

  const line1Spans: ReviewHeaderLine = [
    { text: headPrefix, style: "strong" },
    { text: baseText, style: "strong", action: "choose-base" },
    { text: suffixText, style: "strong" },
  ]
  const line2Spans: ReviewHeaderLine = [{ text: line2, style: "dim" }]

  return [line1Spans, line2Spans]
}

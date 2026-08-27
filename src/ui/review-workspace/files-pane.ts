import type { ReviewState } from "../../review/core/state"
import { coverageForFile, visibleReviewFiles } from "../../review/core/selectors"
import type { ReviewCoverage } from "../../review/core/selectors"

export type ReviewFileSpan = Readonly<{
  text: string
  style: "plain" | "dim" | "strong" | "viewed" | "changed" | "feedback"
}>

export type ReviewFileRow = Readonly<{
  fileKey: string
  path: string
  marker: string
  hasFeedback: boolean
  coverage: ReviewCoverage
  spans: readonly ReviewFileSpan[]
}>

function markerForCoverage(coverage: ReviewCoverage, hasFeedback: boolean): string {
  let base: string
  switch (coverage) {
    case "viewed":
      base = "●"
      break
    case "changed-after-review":
      base = "!"
      break
    case "reviewing":
      base = "◐"
      break
    case "not-viewed":
    default:
      base = "○"
      break
  }
  if (hasFeedback) return `${base}◆`
  return base
}

export function reviewFileRows(state: ReviewState): readonly ReviewFileRow[] {
  const visible = visibleReviewFiles(state)
  const feedbackByKey = new Set(state.feedback.map((fb) => fb.anchor.fileKey))
  const rows: ReviewFileRow[] = []
  for (const file of visible) {
    const coverage = coverageForFile(file, state.viewed, state.selection.fileKey)
    const hasFeedback = feedbackByKey.has(file.key)
    const marker = markerForCoverage(coverage, hasFeedback)
    const spans: ReviewFileSpan[] = [
      { text: marker, style: hasFeedback ? "feedback" : coverage === "viewed" ? "viewed" : coverage === "changed-after-review" ? "changed" : "plain" },
      { text: " ", style: "plain" },
      { text: file.path, style: "plain" },
    ]
    rows.push({
      fileKey: file.key,
      path: file.path,
      marker,
      hasFeedback,
      coverage,
      spans,
    })
  }
  return rows
}

import type { ReviewDocument } from "./types"

export type ReviewSelection = Readonly<{ fileKey: string | null; hunkIndex: number }>
export type ReviewRevealIntent = Readonly<{ fileTopToken: number; hunkToken: number; scrollToFeedback: boolean }>
export type ReviewProjection =
  | Readonly<{ kind: "aggregate" }>
  | Readonly<{ kind: "since-last-review"; fromHeadOid: string }>
  | Readonly<{ kind: "commit"; oid: string }>

export type ExpandedGap = Readonly<{ fileKey: string; gapId: string; expanded: boolean }>
export type SubmittedReviewRef = Readonly<{ artifactId: string; generationId: string; headOid: string; submittedAt: string }>
export type ReviewState = Readonly<{
  document: ReviewDocument
  revision: number
  projection: ReviewProjection
  selection: ReviewSelection
  reveal: ReviewRevealIntent
  filter: Readonly<{ query: string; scope: "all" | "unreviewed" | "changed" | "feedback" }>
  expandedGaps: readonly ExpandedGap[]
  lastSubmission: SubmittedReviewRef | null
}>

export function createInitialReviewState(document: ReviewDocument): ReviewState {
  const firstFile = document.files[0] ?? null
  return {
    document,
    revision: 0,
    projection: { kind: "aggregate" },
    selection: { fileKey: firstFile?.key ?? null, hunkIndex: 0 },
    reveal: { fileTopToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    expandedGaps: [],
    lastSubmission: null,
  }
}

import type { ReviewDocument, ReviewFeedback, ReviewFeedbackDraft, ReviewProjection } from "./types"

export type ViewedRecord = Readonly<{
  fileKey: string
  path: string
  contentId: string
  generationId: string
  viewedAt: string
}>

export type ReviewSelection = Readonly<{ fileKey: string | null; hunkIndex: number }>
export type ReviewRevealIntent = Readonly<{ fileTopToken: number; fileTopRequestToken: number; hunkToken: number; scrollToFeedback: boolean }>
export type ExpandedGap = Readonly<{ fileKey: string; gapId: string; expanded: boolean }>
export type SubmittedReviewRef = Readonly<{ artifactId: string; generationId: string; headOid: string; submittedAt: string }>
export type { ReviewProjection } from "./types"
export type { ReviewProjectionDocument } from "./types"
export type { SourceContextRequest, SourceContextResult } from "./types"
export type ReviewState = Readonly<{
  document: ReviewDocument
  revision: number
  projection: ReviewProjection
  selection: ReviewSelection
  reveal: ReviewRevealIntent
  filter: Readonly<{ query: string; scope: "all" | "unreviewed" | "changed" | "feedback" }>
  viewed: Readonly<Record<string, ViewedRecord>>
  feedback: readonly ReviewFeedback[]
  draft: ReviewFeedbackDraft | null
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
    reveal: { fileTopToken: 0, fileTopRequestToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    viewed: {},
    feedback: [],
    draft: null,
    expandedGaps: [],
    lastSubmission: null,
  }
}

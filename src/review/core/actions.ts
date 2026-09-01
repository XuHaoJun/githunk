import type { ReviewAnchor, ReviewDocument, ReviewFeedback, ReviewFeedbackDraft } from "./types"
import type { ReviewProjection, ViewedRecord, ExpandedGap, ReviewSelection, ReviewLineSelection } from "./state"

export type ReviewAction =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/set-line"; selection: ReviewLineSelection }
  | { type: "selection/move-line"; direction: "next" | "previous" }
  | { type: "selection/viewport-anchor"; fileKey: string; hunkIndex: number; reveal?: "hunk" }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }
  | { type: "viewed/mark"; fileKey: string; record: ViewedRecord }
  | { type: "viewed/unmark"; fileKey: string }
  | { type: "feedback/start-draft"; draft: ReviewFeedbackDraft }
  | { type: "feedback/update-draft"; patch: Partial<Pick<ReviewFeedbackDraft, "body" | "severity" | "kind" | "replacement">> }
  | { type: "feedback/cancel-draft" }
  | { type: "feedback/create"; feedback: ReviewFeedback }
  | { type: "feedback/edit"; id: string; patch: Partial<Pick<ReviewFeedback, "body" | "severity" | "replacement">>; updatedAt: string }
  | { type: "feedback/delete"; id: string }
  | { type: "feedback/reanchor"; id: string; anchor: ReviewAnchor; updatedAt: string }
  | { type: "feedback/next" }
  | { type: "feedback/previous" }
  | { type: "document/reconciled"; document: ReviewDocument; viewed: Readonly<Record<string, ViewedRecord>>; feedback: readonly ReviewFeedback[]; selection: ReviewSelection; lineSelection: ReviewLineSelection | null; expandedGaps: readonly ExpandedGap[] }

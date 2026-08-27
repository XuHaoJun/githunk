import type { ReviewProjection } from "./state"
import type { ReviewAnchor, ReviewFeedback, ReviewFeedbackDraft } from "./types"

export type ReviewAction =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/viewport-anchor"; fileKey: string; hunkIndex: number }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }
  | { type: "feedback/start-draft"; draft: ReviewFeedbackDraft }
  | { type: "feedback/update-draft"; patch: Partial<Pick<ReviewFeedbackDraft, "body" | "severity" | "kind" | "replacement">> }
  | { type: "feedback/cancel-draft" }
  | { type: "feedback/create"; feedback: ReviewFeedback }
  | { type: "feedback/edit"; id: string; patch: Partial<Pick<ReviewFeedback, "body" | "severity" | "replacement">>; updatedAt: string }
  | { type: "feedback/delete"; id: string }
  | { type: "feedback/reanchor"; id: string; anchor: ReviewAnchor; updatedAt: string }
  | { type: "feedback/next" }
  | { type: "feedback/previous" }

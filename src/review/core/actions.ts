import type { ReviewProjection } from "./state"

export type ReviewAction =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/viewport-anchor"; fileKey: string; hunkIndex: number }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }

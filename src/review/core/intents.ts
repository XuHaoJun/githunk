import type { ReviewAction } from "./actions"
import type { ReviewState, ReviewProjection } from "./state"

export type ReviewIntent =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/viewport-anchor"; fileKey: string; hunkIndex: number }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }

export type ReviewIntentValidationCode =
  | "file-not-found"
  | "hunk-not-found"
  | "projection-invalid"
  | "gap-not-found"
  | "query-invalid"
  | "commit-not-found"

export class ReviewIntentValidationError extends Error {
  readonly code: ReviewIntentValidationCode
  constructor(code: ReviewIntentValidationCode, message: string) {
    super(message)
    this.name = "ReviewIntentValidationError"
    this.code = code
  }
}

function validateFileKey(state: ReviewState, fileKey: string): void {
  const found = state.document.files.some((f) => f.key === fileKey)
  if (!found) throw new ReviewIntentValidationError("file-not-found", `file not found: ${fileKey}`)
}

function validateHunkBounds(state: ReviewState, fileKey: string, hunkIndex: number): void {
  const file = state.document.files.find((f) => f.key === fileKey)
  if (!file) throw new ReviewIntentValidationError("file-not-found", `file not found: ${fileKey}`)
  const maxIndex = Math.max(0, file.hunks.length - 1)
  // files with no hunks: only hunkIndex 0 is valid
  const upper = file.hunks.length === 0 ? 0 : maxIndex
  if (hunkIndex < 0 || hunkIndex > upper) {
    throw new ReviewIntentValidationError("hunk-not-found", `hunk ${hunkIndex} not found in ${fileKey}`)
  }
}

function validateProjection(state: ReviewState, projection: ReviewProjection): void {
  if (projection.kind === "aggregate") return
  if (projection.kind === "commit") {
    if (!projection.oid || projection.oid.trim() === "") {
      throw new ReviewIntentValidationError("projection-invalid", "commit oid must be non-empty")
    }
    const exists = state.document.commits.some((c) => c.oid === projection.oid)
    if (!exists) throw new ReviewIntentValidationError("commit-not-found", `commit not found: ${projection.oid}`)
    return
  }
  if (projection.kind === "since-last-review") {
    if (!projection.fromHeadOid || projection.fromHeadOid.trim() === "") {
      throw new ReviewIntentValidationError("projection-invalid", "fromHeadOid must be non-empty")
    }
    const exists = state.document.commits.some((c) => c.oid === projection.fromHeadOid)
    if (!exists) throw new ReviewIntentValidationError("commit-not-found", `commit not found: ${projection.fromHeadOid}`)
    return
  }
}

export function planReviewIntent(state: ReviewState, intent: ReviewIntent): ReviewAction {
  switch (intent.type) {
    case "selection/select-file": {
      validateFileKey(state, intent.fileKey)
      return { type: "selection/select-file", fileKey: intent.fileKey }
    }
    case "selection/move": {
      // No validation beyond type; clamp handled in reducer/navigation
      return { type: "selection/move", unit: intent.unit, direction: intent.direction }
    }
    case "selection/viewport-anchor": {
      validateFileKey(state, intent.fileKey)
      validateHunkBounds(state, intent.fileKey, intent.hunkIndex)
      return { type: "selection/viewport-anchor", fileKey: intent.fileKey, hunkIndex: intent.hunkIndex }
    }
    case "filter/set-query": {
      // normalize: trim (preserve case for storage? spec says normalization filters over normalized paths)
      // We normalize by trimming; visible filtering does case-insensitive match
      const normalized = intent.query.trim()
      return { type: "filter/set-query", query: normalized }
    }
    case "filter/set-scope": {
      return { type: "filter/set-scope", scope: intent.scope }
    }
    case "projection/set": {
      validateProjection(state, intent.projection)
      return { type: "projection/set", projection: intent.projection }
    }
    case "gap/toggle": {
      validateFileKey(state, intent.fileKey)
      if (!intent.gapId || intent.gapId.trim() === "") {
        throw new ReviewIntentValidationError("gap-not-found", "gapId must be non-empty")
      }
      return { type: "gap/toggle", fileKey: intent.fileKey, gapId: intent.gapId }
    }
  }
}

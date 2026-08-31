import type { ReviewAction } from "./actions"
import type { ReviewState, ReviewLineSelection } from "./state"
import { createLineSelection } from "./anchors"
import type { ReviewProjection } from "./types"
import type { ReviewAnchor, ReviewFeedback, ReviewFeedbackDraft } from "./types"
export type ReviewIntent =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/set-line"; selection: ReviewLineSelection }
  | { type: "selection/move-line"; direction: "next" | "previous" }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }
  | { type: "viewed/mark"; fileKey: string; viewedAt: string }
  | { type: "viewed/unmark"; fileKey: string }
  | { type: "feedback/start-draft"; anchor: ReviewAnchor; kind: "note" | "suggestion"; severity: "comment" | "blocking"; body?: string; replacement?: string }
  | { type: "feedback/update-draft"; body?: string; severity?: "comment" | "blocking"; replacement?: string; kind?: "note" | "suggestion" }
  | { type: "feedback/cancel-draft" }
  | { type: "feedback/create"; id: string; createdAt: string }
  | { type: "feedback/edit"; id: string; body?: string; severity?: "comment" | "blocking"; replacement?: string; updatedAt: string }
  | { type: "feedback/delete"; id: string }
  | { type: "feedback/reanchor"; id: string; anchor: ReviewAnchor; updatedAt: string }
  | { type: "feedback/next" }
  | { type: "feedback/previous" }
export type ReviewIntentValidationCode =
  | "file-not-found"
  | "hunk-not-found"
  | "projection-invalid"
  | "gap-not-found"
  | "query-invalid"
  | "commit-not-found"
  | "anchor-invalid"
  | "suggestion-invalid"
  | "draft-missing"
  | "draft-exists"
  | "feedback-not-found"
  | "body-invalid"
  | "id-invalid"

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

function validateAnchor(state: ReviewState, anchor: ReviewAnchor): void {
  const file = state.document.files.find((f) => f.key === anchor.fileKey)
  if (!file) throw new ReviewIntentValidationError("anchor-invalid", `anchor file not found: ${anchor.fileKey}`)
  if (file.contentId !== anchor.contentId) {
    // Allow stale contentId? For creation, should match current file's contentId; for reanchor, new anchor should match current file's contentId.
    // We enforce matching for draft creation to ensure precise source: mismatch indicates stale anchor.
    throw new ReviewIntentValidationError("anchor-invalid", `anchor contentId does not match file ${anchor.fileKey}`)
  }
  if (anchor.kind === "file") {
    // file anchors always valid if file exists; binary files allow file anchors
    return
  }
  // range anchor
  if (anchor.kind === "range") {
    if (file.source === "binary" || file.source === "too-large") {
      throw new ReviewIntentValidationError("anchor-invalid", `range anchor not allowed for binary or too-large file ${anchor.fileKey}`)
    }
    if (anchor.side !== "old" && anchor.side !== "new") {
      throw new ReviewIntentValidationError("anchor-invalid", `invalid side ${anchor.side as string}`)
    }
    if (!Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine)) {
      throw new ReviewIntentValidationError("anchor-invalid", `start/end must be integers`)
    }
    if (anchor.startLine < 1 || anchor.endLine < 1) {
      throw new ReviewIntentValidationError("anchor-invalid", `line numbers must be >=1`)
    }
    if (anchor.endLine < anchor.startLine) {
      throw new ReviewIntentValidationError("anchor-invalid", `endLine must be >= startLine`)
    }
    if (!Number.isInteger(anchor.ownerHunkIndex) || anchor.ownerHunkIndex < 0) {
      throw new ReviewIntentValidationError("anchor-invalid", `ownerHunkIndex invalid`)
    }
    const ownerExists = file.hunks.some((h) => h.index === anchor.ownerHunkIndex)
    if (!ownerExists) {
      throw new ReviewIntentValidationError("anchor-invalid", `owner hunk ${anchor.ownerHunkIndex} not found in ${anchor.fileKey}`)
    }
    if (typeof anchor.contextDigest !== "string" || anchor.contextDigest.length === 0) {
      throw new ReviewIntentValidationError("anchor-invalid", `contextDigest required`)
    }
  }
}
function validateSuggestionPrerequisites(state: ReviewState, anchor: ReviewAnchor, kind: "note" | "suggestion", replacement?: string, strict = true): void {
  if (kind !== "suggestion") return
  if (anchor.kind !== "range" || anchor.side !== "new") throw new ReviewIntentValidationError("suggestion-invalid", "suggestion requires new-side range")
  if (strict && (!replacement || replacement.trim().length === 0)) throw new ReviewIntentValidationError("suggestion-invalid", "suggestion requires non-empty replacement text")
  const file = state.document.files.find((f) => f.key === anchor.fileKey)
  if (file && (file.source === "binary" || file.source === "too-large")) throw new ReviewIntentValidationError("suggestion-invalid", "suggestion not allowed")
}

function validateNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new ReviewIntentValidationError("id-invalid", `id must be non-empty`)
  }
}
export function planReviewIntent(state: ReviewState, intent: ReviewIntent): ReviewAction {
  switch (intent.type) {
    case "selection/select-file": {
      validateFileKey(state, intent.fileKey)
      return { type: "selection/select-file", fileKey: intent.fileKey }
    }
    case "selection/move": {
      return { type: "selection/move", unit: intent.unit, direction: intent.direction }
    }
    case "selection/set-line": {
      const s = intent.selection
      validateFileKey(state, s.fileKey)
      validateHunkBounds(state, s.fileKey, s.hunkIndex)
      const file = state.document.files.find((f) => f.key === s.fileKey)!
      try {
        const expected = createLineSelection(file, { hunkIndex: s.hunkIndex, side: s.side, line: s.line })
        if (expected.contentId !== s.contentId || expected.contextDigest !== s.contextDigest) throw new Error("identity mismatch")
      } catch (error) {
        throw new ReviewIntentValidationError("anchor-invalid", error instanceof Error ? error.message : "invalid line selection")
      }
      return { type: "selection/set-line", selection: s }
    }
    case "selection/move-line": return { type: "selection/move-line", direction: intent.direction }
    case "selection/viewport-anchor": {
      validateFileKey(state, intent.fileKey)
      validateHunkBounds(state, intent.fileKey, intent.hunkIndex)
      return {
        type: "selection/viewport-anchor",
        fileKey: intent.fileKey,
        hunkIndex: intent.hunkIndex,
        ...(intent.reveal ? { reveal: intent.reveal } : {}),
      }
    }
    case "filter/set-query": {
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
    case "viewed/mark": {
      validateFileKey(state, intent.fileKey)
      if (!intent.viewedAt || intent.viewedAt.trim() === "") {
        throw new ReviewIntentValidationError("body-invalid", "viewedAt required")
      }
      // Commit projection is inspection-only: marking aggregate Viewed is disabled because the
      // projection may omit changes from other commits (spec §6.3). Since-last eligibility
      // (viewed in submitted generation + projection contains every change) is enforced by the
      // projection loader's isAncestor/history-rewritten check and reconcile, so marking in
      // since-last is allowed here and advances coverage to the current aggregate ContentIdentity.
      if (state.projection.kind === "commit") {
        throw new ReviewIntentValidationError("projection-invalid", "cannot mark viewed in commit projection")
      }
      const file = state.document.files.find((f) => f.key === intent.fileKey)
      if (!file) throw new ReviewIntentValidationError("file-not-found", `file not found: ${intent.fileKey}`)
      const record = {
        fileKey: file.key,
        path: file.path,
        contentId: file.contentId,
        generationId: state.document.generation.id,
        viewedAt: intent.viewedAt,
      } as const
      return { type: "viewed/mark", fileKey: intent.fileKey, record }
    }
    case "viewed/unmark": {
      validateFileKey(state, intent.fileKey)
      return { type: "viewed/unmark", fileKey: intent.fileKey }
    }
    case "feedback/start-draft": {
      validateNonEmptyId(intent.anchor.fileKey)
      validateAnchor(state, intent.anchor)
      validateSuggestionPrerequisites(state, intent.anchor, intent.kind, intent.replacement, false)
      const body = intent.body ?? ""
      const draft = {
        anchor: intent.anchor,
        kind: intent.kind,
        severity: intent.severity,
        body,
        ...(intent.replacement !== undefined ? { replacement: intent.replacement } : {}),
      } as const
      return { type: "feedback/start-draft", draft }
    }
    case "feedback/update-draft": {
      if (!state.draft) {
        throw new ReviewIntentValidationError("draft-missing", "no draft to update")
      }
      if (intent.severity !== undefined && intent.severity !== "comment" && intent.severity !== "blocking") {
        throw new ReviewIntentValidationError("body-invalid", `invalid severity`)
      }
      if (intent.kind !== undefined && intent.kind !== "note" && intent.kind !== "suggestion") {
        throw new ReviewIntentValidationError("body-invalid", `invalid kind`)
      }
      const nextKind = intent.kind ?? state.draft.kind
      const nextReplacement = intent.replacement !== undefined ? intent.replacement : state.draft.replacement
      const nextAnchor = state.draft.anchor
      validateSuggestionPrerequisites(state, nextAnchor, nextKind, nextReplacement)
      const patch: { body?: string; severity?: "comment" | "blocking"; kind?: "note" | "suggestion"; replacement?: string } = {}
      if (intent.body !== undefined) patch.body = intent.body
      if (intent.severity !== undefined) patch.severity = intent.severity
      if (intent.kind !== undefined) patch.kind = intent.kind
      if (intent.replacement !== undefined) patch.replacement = intent.replacement
      return { type: "feedback/update-draft", patch }
    }
    case "feedback/cancel-draft": {
      if (!state.draft) {
        throw new ReviewIntentValidationError("draft-missing", "no draft to cancel")
      }
      return { type: "feedback/cancel-draft" }
    }
    case "feedback/create": {
      if (!state.draft) {
        throw new ReviewIntentValidationError("draft-missing", "no draft to create feedback from")
      }
      validateNonEmptyId(intent.id)
      if (!intent.createdAt || intent.createdAt.trim() === "") {
        throw new ReviewIntentValidationError("body-invalid", "createdAt required")
      }
      const draft = state.draft
      if (draft.kind === "note" && draft.body.trim().length === 0) {
        throw new ReviewIntentValidationError("body-invalid", "note body must be non-empty")
      }
      validateSuggestionPrerequisites(state, draft.anchor, draft.kind, draft.replacement)
      if (state.feedback.some((f) => f.id === intent.id)) {
        throw new ReviewIntentValidationError("id-invalid", `duplicate feedback id ${intent.id}`)
      }
      const feedback = {
        id: intent.id,
        kind: draft.kind,
        severity: draft.severity,
        body: draft.body,
        ...(draft.replacement !== undefined ? { replacement: draft.replacement } : {}),
        anchor: draft.anchor,
        resolution: "active" as const,
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
      } as const
      return { type: "feedback/create", feedback }
    }
    case "feedback/edit": {
      validateNonEmptyId(intent.id)
      const existing = state.feedback.find((f) => f.id === intent.id)
      if (!existing) throw new ReviewIntentValidationError("feedback-not-found", `feedback not found: ${intent.id}`)
      if (!intent.updatedAt || intent.updatedAt.trim() === "") {
        throw new ReviewIntentValidationError("body-invalid", "updatedAt required")
      }
      const nextSeverity = intent.severity ?? existing.severity
      const nextReplacement = intent.replacement !== undefined ? intent.replacement : existing.replacement
      if (nextSeverity !== "comment" && nextSeverity !== "blocking") {
        throw new ReviewIntentValidationError("body-invalid", "invalid severity")
      }
      if (existing.kind === "suggestion") {
        validateSuggestionPrerequisites(state, existing.anchor, "suggestion", nextReplacement)
      }
      if (existing.kind === "note" && intent.body !== undefined && intent.body.trim().length === 0) {
        throw new ReviewIntentValidationError("body-invalid", "note body must be non-empty")
      }
      const patch: { body?: string; severity?: "comment" | "blocking"; replacement?: string } = {}
      if (intent.body !== undefined) patch.body = intent.body
      if (intent.severity !== undefined) patch.severity = intent.severity
      if (intent.replacement !== undefined) patch.replacement = intent.replacement
      return { type: "feedback/edit", id: intent.id, patch, updatedAt: intent.updatedAt }
    }
    case "feedback/delete": {
      validateNonEmptyId(intent.id)
      const exists = state.feedback.some((f) => f.id === intent.id)
      if (!exists) throw new ReviewIntentValidationError("feedback-not-found", `feedback not found: ${intent.id}`)
      return { type: "feedback/delete", id: intent.id }
    }
    case "feedback/reanchor": {
      validateNonEmptyId(intent.id)
      const existing = state.feedback.find((f) => f.id === intent.id)
      if (!existing) throw new ReviewIntentValidationError("feedback-not-found", `feedback not found: ${intent.id}`)
      if (!intent.updatedAt || intent.updatedAt.trim() === "") {
        throw new ReviewIntentValidationError("body-invalid", "updatedAt required")
      }
      validateAnchor(state, intent.anchor)
      validateSuggestionPrerequisites(state, intent.anchor, existing.kind, existing.replacement)
      return { type: "feedback/reanchor", id: intent.id, anchor: intent.anchor, updatedAt: intent.updatedAt }
    }
    case "feedback/next": {
      return { type: "feedback/next" }
    }
    case "feedback/previous": {
      return { type: "feedback/previous" }
    }
  }
}

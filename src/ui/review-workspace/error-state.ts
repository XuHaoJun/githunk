import type { ReviewDocument } from "../../review/core/types"

export type ReviewWorkspaceError = Readonly<{
  kind: "invalid-base" | "history-rewritten" | "git" | "parse" | "source" | "storage" | "corrupt-state"
  title: string
  detail: string
  action: "choose-base" | "retry" | "dismiss" | "open-feedback"
}>

export function createInvalidBaseError(baseRef: string, detail?: string): ReviewWorkspaceError {
  return {
    kind: "invalid-base",
    title: "Invalid base branch",
    detail: detail ?? `Base ref "${baseRef}" does not resolve to a commit. Choose a valid base to open the review.`,
    action: "choose-base",
  }
}

export function createHistoryRewrittenError(lastHeadOid: string, headOid: string, detail?: string): ReviewWorkspaceError {
  return {
    kind: "history-rewritten",
    title: "History rewritten",
    detail: detail ?? `Previous review HEAD ${lastHeadOid.slice(0, 8)} is not an ancestor of current HEAD ${headOid.slice(0, 8)}. Since Last Review is unavailable, but aggregate coverage is preserved.`,
    action: "dismiss",
  }
}

export function createGitError(detail: string): ReviewWorkspaceError {
  return {
    kind: "git",
    title: "Git operation failed",
    detail,
    action: "retry",
  }
}

export function createParseError(detail: string): ReviewWorkspaceError {
  return {
    kind: "parse",
    title: "Failed to parse patch",
    detail,
    action: "retry",
  }
}

export function createSourceError(detail: string): ReviewWorkspaceError {
  return {
    kind: "source",
    title: "Source unavailable",
    detail,
    action: "dismiss",
  }
}

export function createStorageError(detail: string): ReviewWorkspaceError {
  return {
    kind: "storage",
    title: "Failed to save review state",
    detail,
    action: "retry",
  }
}

export function createCorruptStateError(quarantinePath: string, detail?: string): ReviewWorkspaceError {
  return {
    kind: "corrupt-state",
    title: "Review state was corrupt",
    detail: detail ?? `Persisted review state was corrupt and moved to ${quarantinePath}. Starting with empty state.`,
    action: "dismiss",
  }
}

export function classifyLoadError(err: unknown): ReviewWorkspaceError {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes("base ref does not resolve") || lower.includes("invalid base") || lower.includes("does not resolve to a commit")) {
    // Extract base ref if present in message
    const match = message.match(/base ref[^:]*:\s*(\S+)/i)
    const base = match?.[1] ?? "unknown"
    return createInvalidBaseError(base, message)
  }
  if (lower.includes("failed to parse") || lower.includes("unsupported patch") || lower.includes("malformed patch") || (lower.includes("parse patch") && !lower.includes("rev-parse"))) {
    return createParseError(message)
  }
  if (lower.includes("unsupported") || lower.includes("malformed")) {
    return createParseError(message)
  }
  if (lower.includes("binary") || lower.includes("too-large") || lower.includes("too large") || lower.includes("source")) {
    return createSourceError(message)
  }
  if (lower.includes("storage") || lower.includes("quarantine") || lower.includes("persist")) {
    return createStorageError(message)
  }
  return createGitError(message)
}

/**
 * Empty review and detached snapshot are status states, not errors.
 * Helpers to identify them.
 */
export function isEmptyReview(document: ReviewDocument): boolean {
  return document.files.length === 0
}

export function isDetachedSnapshot(document: ReviewDocument): boolean {
  return document.identity.headRef === null
}

export function workspaceStatusForDocument(document: ReviewDocument): "empty" | "detached" | "normal" {
  if (isEmptyReview(document)) return "empty"
  if (isDetachedSnapshot(document)) return "detached"
  return "normal"
}

export function isReviewWorkspaceError(value: unknown): value is ReviewWorkspaceError {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.kind === "string" &&
    ["invalid-base", "history-rewritten", "git", "parse", "source", "storage", "corrupt-state"].includes(v.kind as string) &&
    typeof v.title === "string" &&
    typeof v.detail === "string" &&
    typeof v.action === "string" &&
    ["choose-base", "retry", "dismiss", "open-feedback"].includes(v.action as string)
  )
}

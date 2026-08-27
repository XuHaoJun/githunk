import type { ReviewFile } from "./types"
import type { ReviewState } from "./state"
import type { ReviewFeedback } from "./types"

export function reviewFileMatchesFilter(file: Pick<ReviewFile, "path" | "previousPath">, query: string): boolean {
  const nq = query.trim().toLowerCase()
  if (nq === "") return true
  if (file.path.toLowerCase().includes(nq)) return true
  if (file.previousPath && file.previousPath.toLowerCase().includes(nq)) return true
  return false
}

export function visibleReviewFiles(state: Pick<ReviewState, "document" | "filter" | "feedback">): readonly ReviewFile[] {
  const q = state.filter.query
  const scope = state.filter.scope
  // Preserve document order; apply scope + query
  return state.document.files.filter((file) => {
    if (!reviewFileMatchesFilter(file, q)) return false
    if (scope === "feedback") {
      return state.feedback.some((fb) => fb.anchor.fileKey === file.key)
    }
    // For scopes not yet implemented (unreviewed/changed), fallback to query-only until Task4
    // Keep files visible for all/changed/unreviewed to avoid breaking existing tests
    if (scope === "all") return true
    if (scope === "unreviewed" || scope === "changed") return true
    return true
  })
}

export function sortedReviewFeedback(state: Pick<ReviewState, "document" | "feedback">): readonly ReviewFeedback[] {
  const indexByKey = new Map(state.document.files.map((f, i) => [f.key, i] as const))
  return [...state.feedback].sort((a, b) => {
    const ia = indexByKey.get(a.anchor.fileKey) ?? Number.MAX_SAFE_INTEGER
    const ib = indexByKey.get(b.anchor.fileKey) ?? Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    const la = a.anchor.kind === "range" ? a.anchor.startLine : 0
    const lb = b.anchor.kind === "range" ? b.anchor.startLine : 0
    if (la !== lb) return la - lb
    return a.id.localeCompare(b.id)
  })
}

export function feedbackForFile(state: Pick<ReviewState, "feedback">, fileKey: string): readonly ReviewFeedback[] {
  return state.feedback.filter((fb) => fb.anchor.fileKey === fileKey)
}

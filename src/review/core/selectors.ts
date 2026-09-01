import type { ReviewFile } from "./types"
import type { ReviewState, ViewedRecord } from "./state"
import type { ReviewFeedback } from "./types"

export type ReviewCoverage = "viewed" | "changed-after-review" | "not-viewed" | "reviewing"

function resolveViewedRecord(
  file: Pick<ReviewFile, "key" | "path" | "contentId">,
  viewed: Readonly<Record<string, ViewedRecord>> | ViewedRecord | null | undefined,
): ViewedRecord | undefined {
  if (!viewed) return undefined
  if (typeof viewed === "object" && "fileKey" in viewed && "path" in viewed && "contentId" in viewed) {
    return viewed as ViewedRecord
  }
  return (viewed as Readonly<Record<string, ViewedRecord>>)[file.key]
}

export function coverageForFile(
  file: Pick<ReviewFile, "key" | "path" | "contentId">,
  viewed: Readonly<Record<string, ViewedRecord>> | ViewedRecord | null | undefined,
  selectedFileKey?: string | null,
): ReviewCoverage {
  const record = resolveViewedRecord(file, viewed)
  if (!record) {
    if (selectedFileKey !== undefined && selectedFileKey !== null && selectedFileKey === file.key) {
      return "reviewing"
    }
    return "not-viewed"
  }
  if (record.path === file.path && record.contentId === file.contentId) {
    return "viewed"
  }
  return "changed-after-review"
}

export type ReviewProgress = Readonly<{
  total: number
  viewed: number
  reviewing: number
  changed: number
  unreviewed: number
  pending: number
}>

export function reviewProgress(state: Pick<ReviewState, "document" | "viewed" | "selection" | "feedback">): ReviewProgress {
  let viewed = 0
  let reviewing = 0
  let changed = 0
  let unreviewed = 0
  for (const file of state.document.files) {
    const cov = coverageForFile(file, state.viewed, state.selection.fileKey)
    if (cov === "viewed") viewed++
    else if (cov === "reviewing") reviewing++
    else if (cov === "changed-after-review") changed++
    else unreviewed++
  }
  return {
    total: state.document.files.length,
    viewed,
    reviewing,
    changed,
    unreviewed,
    pending: state.feedback.length,
  }
}

export function canMarkViewedInProjection(state: Pick<ReviewState, "projection">): boolean {
  if (state.projection.kind === "commit") return false
  return true
}

export function reviewFileMatchesFilter(file: Pick<ReviewFile, "path" | "previousPath">, query: string): boolean {
  const nq = query.trim().toLowerCase()
  if (nq === "") return true
  if (file.path.toLowerCase().includes(nq)) return true
  if (file.previousPath && file.previousPath.toLowerCase().includes(nq)) return true
  return false
}

export function visibleReviewFiles(state: Pick<ReviewState, "document" | "filter" | "feedback"> & Partial<Pick<ReviewState, "viewed" | "selection">>): readonly ReviewFile[] {
  const q = state.filter.query
  const scope = state.filter.scope
  return state.document.files.filter((file) => {
    if (!reviewFileMatchesFilter(file, q)) return false
    if (scope === "feedback") {
      return state.feedback.some((fb) => fb.anchor.fileKey === file.key)
    }
    if (scope === "unreviewed") {
      const viewed = (state.viewed ?? {}) as Readonly<Record<string, ViewedRecord>>
      const selectedKey = state.selection?.fileKey ?? null
      const cov = coverageForFile(file, viewed, selectedKey)
      return cov === "not-viewed" || cov === "reviewing"
    }
    if (scope === "changed") {
      const viewed = (state.viewed ?? {}) as Readonly<Record<string, ViewedRecord>>
      const cov = coverageForFile(file, viewed)
      return cov === "changed-after-review"
    }
    if (scope === "all") return true
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

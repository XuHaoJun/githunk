import type { ReviewFile } from "./types"
import type { ReviewState } from "./state"

export function reviewFileMatchesFilter(file: Pick<ReviewFile, "path" | "previousPath">, query: string): boolean {
  const nq = query.trim().toLowerCase()
  if (nq === "") return true
  if (file.path.toLowerCase().includes(nq)) return true
  if (file.previousPath && file.previousPath.toLowerCase().includes(nq)) return true
  return false
}

export function visibleReviewFiles(state: Pick<ReviewState, "document" | "filter">): readonly ReviewFile[] {
  const q = state.filter.query
  // Preserve document order
  return state.document.files.filter((file) => reviewFileMatchesFilter(file, q))
}

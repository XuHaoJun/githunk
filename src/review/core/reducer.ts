import type { ReviewAction } from "./actions"
import type { ReviewState } from "./state"
import { visibleReviewFiles } from "./selectors"
import { moveReviewSelection } from "./navigation"

function projectionsEqual(a: ReviewState["projection"], b: ReviewState["projection"]): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "aggregate" && b.kind === "aggregate") return true
  if (a.kind === "commit" && b.kind === "commit") return a.oid === b.oid
  if (a.kind === "since-last-review" && b.kind === "since-last-review") return a.fromHeadOid === b.fromHeadOid
  return false
}

export function reduceReviewState(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "selection/select-file": {
      const file = state.document.files.find((f) => f.key === action.fileKey)
      if (!file) return state
      const nextSelection = { fileKey: file.key, hunkIndex: 0 }
      // Explicit reselection must increment reveal even if same file
      const nextReveal = {
        fileTopToken: state.reveal.fileTopToken + 1,
        hunkToken: state.reveal.hunkToken,
        scrollToFeedback: false,
      }
      return {
        ...state,
        selection: nextSelection,
        reveal: nextReveal,
        revision: state.revision + 1,
      }
    }
    case "selection/move": {
      const target = moveReviewSelection(state, action.unit, action.direction)
      if (!target) return state
      return {
        ...state,
        selection: target.selection,
        reveal: target.reveal,
        revision: state.revision + 1,
      }
    }
    case "selection/viewport-anchor": {
      const file = state.document.files.find((f) => f.key === action.fileKey)
      if (!file) return state
      const maxIndex = file.hunks.length === 0 ? 0 : file.hunks.length - 1
      const clamped = Math.min(Math.max(action.hunkIndex, 0), Math.max(0, maxIndex))
      // If same as current, no-op (passive anchoring does not bump reveal)
      if (state.selection.fileKey === action.fileKey && state.selection.hunkIndex === clamped) {
        return state
      }
      // Passive anchoring: update selection, keep reveal tokens, increment revision
      return {
        ...state,
        selection: { fileKey: action.fileKey, hunkIndex: clamped },
        revision: state.revision + 1,
      }
    }
    case "filter/set-query": {
      const normalized = action.query
      if (state.filter.query === normalized) return state
      return {
        ...state,
        filter: { ...state.filter, query: normalized },
        revision: state.revision + 1,
      }
    }
    case "filter/set-scope": {
      if (state.filter.scope === action.scope) return state
      return {
        ...state,
        filter: { ...state.filter, scope: action.scope },
        revision: state.revision + 1,
      }
    }
    case "projection/set": {
      if (projectionsEqual(state.projection, action.projection)) return state
      return {
        ...state,
        projection: action.projection,
        revision: state.revision + 1,
      }
    }
    case "gap/toggle": {
      const file = state.document.files.find((f) => f.key === action.fileKey)
      if (!file) return state
      const idx = state.expandedGaps.findIndex((g) => g.fileKey === action.fileKey && g.gapId === action.gapId)
      let nextGaps: readonly typeof state.expandedGaps[number][]
      if (idx >= 0) {
        const current = state.expandedGaps[idx]!
        const toggled = { ...current, expanded: !current.expanded }
        const copy = [...state.expandedGaps]
        copy[idx] = toggled
        nextGaps = copy
      } else {
        nextGaps = [...state.expandedGaps, { fileKey: action.fileKey, gapId: action.gapId, expanded: true }]
      }
      return {
        ...state,
        expandedGaps: nextGaps,
        revision: state.revision + 1,
      }
    }
  }
}

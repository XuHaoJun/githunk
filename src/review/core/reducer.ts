import type { ReviewAction } from "./actions"
import type { ReviewState } from "./state"
import { visibleReviewFiles } from "./selectors"
import { moveReviewSelection, moveReviewLineSelection } from "./navigation"

function projectionsEqual(a: ReviewState["projection"], b: ReviewState["projection"]): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "aggregate" && b.kind === "aggregate") return true
  if (a.kind === "commit" && b.kind === "commit") return a.oid === b.oid
  if (a.kind === "since-last-review" && b.kind === "since-last-review") return a.fromHeadOid === b.fromHeadOid
  return false
}

function sortedFeedbackForNavigation(state: ReviewState) {
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

function feedbackNavigationTarget(
  state: ReviewState,
  direction: "next" | "previous",
): { fileKey: string; hunkIndex: number } | null {
  const sorted = sortedFeedbackForNavigation(state)
  if (sorted.length === 0) return null
  const currentKey = state.selection.fileKey
  const currentHunk = state.selection.hunkIndex
  let currentIdx = -1
  for (let i = 0; i < sorted.length; i++) {
    const fb = sorted[i]!
    if (fb.anchor.fileKey !== currentKey) continue
    if (fb.anchor.kind === "file") {
      currentIdx = i
      break
    }
    if (fb.anchor.ownerHunkIndex === currentHunk) {
      currentIdx = i
      break
    }
  }
  let target: typeof sorted[number] | null = null
  if (direction === "next") {
    if (currentIdx === -1) {
      target = sorted[0] ?? null
    } else if (currentIdx < sorted.length - 1) {
      target = sorted[currentIdx + 1] ?? null
    } else {
      return null
    }
  } else {
    if (currentIdx === -1) {
      target = sorted[sorted.length - 1] ?? null
    } else if (currentIdx > 0) {
      target = sorted[currentIdx - 1] ?? null
    } else {
      return null
    }
  }
  if (!target) return null
  const hunkIndex = target.anchor.kind === "file" ? 0 : target.anchor.ownerHunkIndex
  return { fileKey: target.anchor.fileKey, hunkIndex }
}

export function reduceReviewState(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "selection/select-file": {
      const file = state.document.files.find((f) => f.key === action.fileKey)
      if (!file) return state
      const nextSelection = { fileKey: file.key, hunkIndex: 0 }
      const nextReveal = {
        fileTopToken: state.reveal.fileTopToken + 1,
        fileTopRequestToken: state.reveal.fileTopRequestToken + 1,
        hunkToken: state.reveal.hunkToken,
        scrollToFeedback: false,
      }
      return {
        ...state,
        selection: nextSelection,
        lineSelection: null,
        reveal: nextReveal,
        revision: state.revision + 1,
      }
    }
    case "selection/set-line": {
      const s = action.selection
      if (state.lineSelection && JSON.stringify(state.lineSelection) === JSON.stringify(s)) return state
      return { ...state, selection: { fileKey: s.fileKey, hunkIndex: s.hunkIndex }, lineSelection: s, revision: state.revision + 1 }
    }
    case "selection/move-line": {
      const next = moveReviewLineSelection(state, action.direction)
      if (!next) return state
      return { ...state, lineSelection: next, revision: state.revision + 1 }
    }
    case "selection/move": {
      const target = moveReviewSelection(state, action.unit, action.direction)
      if (!target) return state
      return {
        ...state,
        lineSelection: null,
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
      const reveal = action.reveal === "hunk"
        ? { ...state.reveal, hunkToken: state.reveal.hunkToken + 1, scrollToFeedback: false }
        : state.reveal
      if (state.selection.fileKey === action.fileKey && state.selection.hunkIndex === clamped && reveal === state.reveal) {
        return state
      }
      return {
        ...state,
        lineSelection: null,
        selection: { fileKey: action.fileKey, hunkIndex: clamped },
        reveal,
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
    case "viewed/mark": {
      const file = state.document.files.find((f) => f.key === action.fileKey)
      if (!file) return state
      const existing = state.viewed[action.fileKey]
      if (
        existing &&
        existing.path === action.record.path &&
        existing.contentId === action.record.contentId &&
        existing.generationId === action.record.generationId &&
        existing.viewedAt === action.record.viewedAt
      ) {
        return state
      }
      return {
        ...state,
        viewed: { ...state.viewed, [action.fileKey]: action.record },
        revision: state.revision + 1,
      }
    }
    case "viewed/unmark": {
      if (!(action.fileKey in state.viewed)) return state
      const copy = { ...state.viewed }
      delete copy[action.fileKey]
      return { ...state, viewed: copy, revision: state.revision + 1 }
    }
    case "document/reconciled": {
      const docChanged = action.document !== state.document
      const viewedChanged = action.viewed !== state.viewed
      const feedbackChanged = action.feedback !== state.feedback
      const selectionChanged = action.selection.fileKey !== state.selection.fileKey || action.selection.hunkIndex !== state.selection.hunkIndex
      const lineSelectionChanged = action.lineSelection !== state.lineSelection
      const gapsChanged = action.expandedGaps !== state.expandedGaps
      if (!docChanged && !viewedChanged && !feedbackChanged && !selectionChanged && !lineSelectionChanged && !gapsChanged) return state
      return { ...state, document: action.document, viewed: action.viewed, feedback: action.feedback, selection: action.selection, lineSelection: action.lineSelection, expandedGaps: action.expandedGaps, revision: state.revision + 1 }
    }
    case "feedback/start-draft": {
      return {
        ...state,
        draft: action.draft,
        revision: state.revision + 1,
      }
    }
    case "feedback/update-draft": {
      if (!state.draft) return state
      const nextDraft = { ...state.draft, ...action.patch }
      return {
        ...state,
        draft: nextDraft,
        revision: state.revision + 1,
      }
    }
    case "feedback/cancel-draft": {
      if (!state.draft) return state
      return {
        ...state,
        draft: null,
        revision: state.revision + 1,
      }
    }
    case "feedback/create": {
      return {
        ...state,
        feedback: [...state.feedback, action.feedback],
        draft: null,
        revision: state.revision + 1,
      }
    }
    case "feedback/edit": {
      const idx = state.feedback.findIndex((f) => f.id === action.id)
      if (idx < 0) return state
      const existing = state.feedback[idx]!
      const updated = {
        ...existing,
        ...action.patch,
        updatedAt: action.updatedAt,
      }
      const copy = [...state.feedback]
      copy[idx] = updated
      return {
        ...state,
        feedback: copy,
        revision: state.revision + 1,
      }
    }
    case "feedback/delete": {
      const idx = state.feedback.findIndex((f) => f.id === action.id)
      if (idx < 0) return state
      const copy = state.feedback.filter((f) => f.id !== action.id)
      return {
        ...state,
        feedback: copy,
        revision: state.revision + 1,
      }
    }
    case "feedback/reanchor": {
      const idx = state.feedback.findIndex((f) => f.id === action.id)
      if (idx < 0) return state
      const existing = state.feedback[idx]!
      const updated = {
        ...existing,
        anchor: action.anchor,
        resolution: "active" as const,
        updatedAt: action.updatedAt,
      }
      const copy = [...state.feedback]
      copy[idx] = updated
      return {
        ...state,
        feedback: copy,
        revision: state.revision + 1,
      }
    }
    case "feedback/next": {
      const target = feedbackNavigationTarget(state, "next")
      if (!target) return state
      const crossesFile = target.fileKey !== state.selection.fileKey
      const nextReveal = crossesFile
        ? { fileTopToken: state.reveal.fileTopToken + 1, fileTopRequestToken: state.reveal.fileTopRequestToken, hunkToken: state.reveal.hunkToken, scrollToFeedback: true }
        : { fileTopToken: state.reveal.fileTopToken, fileTopRequestToken: state.reveal.fileTopRequestToken, hunkToken: state.reveal.hunkToken + 1, scrollToFeedback: true }
      return {
        ...state,
        selection: { fileKey: target.fileKey, hunkIndex: target.hunkIndex },
        lineSelection: null,
        reveal: nextReveal,
        revision: state.revision + 1,
      }
    }
    case "feedback/previous": {
      const target = feedbackNavigationTarget(state, "previous")
      if (!target) return state
      const crossesFile = target.fileKey !== state.selection.fileKey
      const nextReveal = crossesFile
        ? { fileTopToken: state.reveal.fileTopToken + 1, fileTopRequestToken: state.reveal.fileTopRequestToken, hunkToken: state.reveal.hunkToken, scrollToFeedback: true }
        : { fileTopToken: state.reveal.fileTopToken, fileTopRequestToken: state.reveal.fileTopRequestToken, hunkToken: state.reveal.hunkToken + 1, scrollToFeedback: true }
      return {
        ...state,
        selection: { fileKey: target.fileKey, hunkIndex: target.hunkIndex },
        lineSelection: null,
        reveal: nextReveal,
        revision: state.revision + 1,
      }
    }
  }
}

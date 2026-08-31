import type { ReviewDocument, ReviewFeedback, ReviewFile } from "./types"
import type { ExpandedGap, ReviewSelection, ViewedRecord, ReviewState, ReviewLineSelection } from "./state"
import { reconcileAnchor } from "./anchors"
import { reduceReviewState } from "./reducer"

export type ReviewFileMatchResult = Readonly<{
  exact: ReadonlyMap<string, ReviewFile>
  rename: ReadonlyMap<string, ReviewFile>
  ambiguous: ReadonlyMap<string, readonly ReviewFile[]>
  newFiles: readonly ReviewFile[]
  copiedFiles: readonly ReviewFile[]
  deletedFiles: readonly ReviewFile[]
  previousToCurrent: ReadonlyMap<string, ReviewFile>
  currentToPrevious: ReadonlyMap<string, ReviewFile>
  ambiguousPreviousKeys: ReadonlySet<string>
}>

export function matchReviewFiles(
  previous: readonly ReviewFile[],
  current: readonly ReviewFile[],
): ReviewFileMatchResult {
  const previousByKey = new Map<string, ReviewFile>()
  for (const f of previous) previousByKey.set(f.key, f)

  const currentByKey = new Map<string, ReviewFile>()
  for (const f of current) currentByKey.set(f.key, f)

  const exact = new Map<string, ReviewFile>()
  const previousMatched = new Set<string>()
  const currentMatched = new Set<string>()

  // 1. Exact: same key
  for (const pf of previous) {
    const cf = currentByKey.get(pf.key)
    if (cf) {
      exact.set(pf.key, cf)
      previousMatched.add(pf.key)
      currentMatched.add(cf.key)
    }
  }

  // Build previousPath -> current files (excluding already exact-matched current)
  const byPreviousPath = new Map<string, ReviewFile[]>()
  for (const cf of current) {
    if (currentMatched.has(cf.key)) continue
    if (!cf.previousPath) continue
    // Exclude copied files from rename candidates; they are handled as copy
    if (cf.kind === "copied") continue
    const list = byPreviousPath.get(cf.previousPath)
    if (list) list.push(cf)
    else byPreviousPath.set(cf.previousPath, [cf])
  }

  const rename = new Map<string, ReviewFile>()
  const ambiguous = new Map<string, readonly ReviewFile[]>()

  // 2. Unambiguous rename: single previousPath -> path
  for (const pf of previous) {
    if (previousMatched.has(pf.key)) continue
    const candidates = byPreviousPath.get(pf.path)
    if (!candidates || candidates.length === 0) continue
    if (candidates.length === 1) {
      const cand = candidates[0]!
      rename.set(pf.key, cand)
      previousMatched.add(pf.key)
      currentMatched.add(cand.key)
    } else {
      ambiguous.set(pf.key, candidates)
      // Do not mark previousMatched; ambiguous refuses guessing
      // Current files remain unmatched for now (they are ambiguous, not allocated)
    }
  }

  // Collect remaining current files
  const newFiles: ReviewFile[] = []
  const copiedFiles: ReviewFile[] = []

  for (const cf of current) {
    if (currentMatched.has(cf.key)) continue
    // If file is ambiguous candidate, it should not be counted as new/copied yet?
    // Check if it appears in ambiguous map values
    let isAmbiguousCandidate = false
    for (const candList of ambiguous.values()) {
      if (candList.includes(cf)) {
        isAmbiguousCandidate = true
        break
      }
    }
    if (isAmbiguousCandidate) {
      // Treat ambiguous candidates as neither new nor copied for now;
      // but for totals, they are effectively new files that cannot be reconciled.
      // Spec says ambiguous refuses guessing; we still need to categorize them.
      // We'll count them as new? However to preserve explicitness, we keep them
      // out of newFiles and let callers see ambiguous. But tests expect
      // newFiles not to include ambiguous? Let's treat ambiguous candidates as not new.
      continue
    }
    if (cf.kind === "copied") copiedFiles.push(cf)
    else newFiles.push(cf)
  }

  // For deleted: previous not matched and not ambiguous
  const deletedFiles: ReviewFile[] = []
  for (const pf of previous) {
    if (previousMatched.has(pf.key)) continue
    if (ambiguous.has(pf.key)) continue
    deletedFiles.push(pf)
  }

  // Build bidirectional maps (only exact+rename)
  const previousToCurrent = new Map<string, ReviewFile>()
  for (const [k, v] of exact) previousToCurrent.set(k, v)
  for (const [k, v] of rename) previousToCurrent.set(k, v)

  const currentToPrevious = new Map<string, ReviewFile>()
  for (const [prevKey, currFile] of previousToCurrent) {
    const prevFile = previousByKey.get(prevKey)
    if (prevFile) currentToPrevious.set(currFile.key, prevFile)
  }

  const ambiguousPreviousKeys = new Set<string>(ambiguous.keys())

  return {
    exact,
    rename,
    ambiguous,
    newFiles,
    copiedFiles,
    deletedFiles,
    previousToCurrent,
    currentToPrevious,
    ambiguousPreviousKeys,
  }
}

export function reconcileViewed(
  previous: Readonly<Record<string, ViewedRecord>>,
  matches: ReviewFileMatchResult,
): Readonly<Record<string, ViewedRecord>> {
  const prevKeys = Object.keys(previous)
  if (prevKeys.length === 0) return previous
  const next: Record<string, ViewedRecord> = {}
  let changed = false
  for (const [prevKey, record] of Object.entries(previous)) {
    const current = matches.previousToCurrent.get(prevKey)
    if (current) {
      if (current.key === prevKey) {
        // Exact match: preserve original record reference (fileKey unchanged, provenance still valid)
        next[current.key] = record
      } else {
        // Rename: must update fileKey for new index, path/contentId stay as originally viewed (invalidates coverage)
        const transferred: ViewedRecord = {
          fileKey: current.key,
          path: record.path,
          contentId: record.contentId,
          generationId: record.generationId,
          viewedAt: record.viewedAt,
        }
        next[current.key] = transferred
        changed = true
      }
    } else {
      // Deleted or ambiguous -> drop
      changed = true
    }
  }
  // Preserve reference when semantically equal (no renames/drops and same count)
  if (!changed && prevKeys.length === Object.keys(next).length) {
    let allSame = true
    for (const k of prevKeys) {
      if (!(k in next) || next[k] !== previous[k]) {
        allSame = false
        break
      }
    }
    if (allSame) return previous
  }
  if (Object.keys(next).length === 0 && prevKeys.length === 0) return previous
  return next
}

export function reconcileFeedback(
  feedback: ReviewFeedback,
  matches: ReviewFileMatchResult,
  document: ReviewDocument,
): ReviewFeedback {
  const prevKey = feedback.anchor.fileKey
  const current = matches.previousToCurrent.get(prevKey)

  let anchorForReconcile = feedback.anchor
  if (current && current.key !== prevKey) {
    if (anchorForReconcile.kind === "file") {
      anchorForReconcile = { kind: "file", fileKey: current.key, contentId: anchorForReconcile.contentId }
    } else {
      anchorForReconcile = { ...anchorForReconcile, fileKey: current.key }
    }
  }

  const result = reconcileAnchor(anchorForReconcile, document)
  // Preserve reference when anchor and resolution unchanged
  const anchorUnchanged =
    result.anchor === feedback.anchor ||
    (result.anchor.kind === feedback.anchor.kind &&
      result.anchor.fileKey === feedback.anchor.fileKey &&
      result.anchor.contentId === feedback.anchor.contentId &&
      (result.anchor.kind === "file" ||
        (result.anchor.kind === "range" &&
          (feedback.anchor as Extract<ReviewFeedback["anchor"], { kind: "range" }>).startLine === result.anchor.startLine &&
          (feedback.anchor as Extract<ReviewFeedback["anchor"], { kind: "range" }>).endLine === result.anchor.endLine &&
          (feedback.anchor as Extract<ReviewFeedback["anchor"], { kind: "range" }>).ownerHunkIndex === result.anchor.ownerHunkIndex &&
          (feedback.anchor as Extract<ReviewFeedback["anchor"], { kind: "range" }>).contextDigest === result.anchor.contextDigest &&
          (feedback.anchor as Extract<ReviewFeedback["anchor"], { kind: "range" }>).side === result.anchor.side)))
  if (anchorUnchanged && result.resolution === feedback.resolution) {
    return feedback
  }
  return {
    ...feedback,
    anchor: result.anchor,
    resolution: result.resolution,
  }
}

export function reconcileSelection(
  selection: ReviewSelection,
  matches: ReviewFileMatchResult,
  document: ReviewDocument,
): ReviewSelection {
  if (selection.fileKey === null) return selection
  const current = matches.previousToCurrent.get(selection.fileKey)
  if (current) {
    const file = document.files.find((f) => f.key === current.key)
    if (!file) return { fileKey: null, hunkIndex: 0 }
    const maxIndex = file.hunks.length === 0 ? 0 : file.hunks.length - 1
    const clamped = Math.min(Math.max(selection.hunkIndex, 0), maxIndex)
    if (current.key === selection.fileKey && clamped === selection.hunkIndex) return selection
    return { fileKey: current.key, hunkIndex: clamped }
  }

  if (matches.ambiguousPreviousKeys.has(selection.fileKey) || matches.deletedFiles.some((f) => f.key === selection.fileKey)) {
    return fallbackSelection(document, selection)
  }

  const stillExists = document.files.find((f) => f.key === selection.fileKey)
  if (stillExists) {
    const maxIndex = stillExists.hunks.length === 0 ? 0 : stillExists.hunks.length - 1
    const clamped = Math.min(Math.max(selection.hunkIndex, 0), maxIndex)
    if (clamped === selection.hunkIndex) return selection
    return { fileKey: stillExists.key, hunkIndex: clamped }
  }

  return fallbackSelection(document, selection)
}

// TODO: nearest visible fallback for middle deletion – currently first-file; deferred to polish (see task-4-report I2)
function fallbackSelection(document: ReviewDocument, previous: ReviewSelection): ReviewSelection {
  if (document.files.length === 0) return { fileKey: null, hunkIndex: 0 }
  const first = document.files[0]!
  return { fileKey: first.key, hunkIndex: 0 }
}

export function reconcileExpandedGaps(
  expandedGaps: readonly ExpandedGap[],
  matches: ReviewFileMatchResult,
): readonly ExpandedGap[] {
  if (expandedGaps.length === 0) return expandedGaps
  const result: ExpandedGap[] = []
  let changed = false
  for (const gap of expandedGaps) {
    const current = matches.previousToCurrent.get(gap.fileKey)
    if (current) {
      if (current.key === gap.fileKey) {
        result.push(gap)
      } else {
        result.push({ fileKey: current.key, gapId: gap.gapId, expanded: gap.expanded })
        changed = true
      }
    } else if (matches.ambiguousPreviousKeys.has(gap.fileKey)) {
      changed = true
      continue
    } else {
      changed = true
      continue
    }
  }
  if (!changed && result.length === expandedGaps.length) {
    let allSame = true
    for (let i = 0; i < result.length; i++) {
      if (result[i] !== expandedGaps[i]) {
        allSame = false
        break
      }
    }
    if (allSame) return expandedGaps
  }
  return result
}

// Deferred: rewritten-history detection via ancestor check (lastSubmission head not ancestor of HEAD)
// and since-last-review projection eligibility are handled in projection loader (Task 6); aggregate
// reconciliation here preserves coverage via identity regardless of history rewrite (see design §9.2).
export function reconcileReviewState(previous: ReviewState, document: ReviewDocument): ReviewState {
  if (previous.document === document) return previous
  const matches = matchReviewFiles(previous.document.files, document.files)
  const viewed = reconcileViewed(previous.viewed, matches)
  const feedback = (() => {
    if (previous.feedback.length === 0) return previous.feedback
    const reconciled = previous.feedback.map((item) => reconcileFeedback(item, matches, document))
    let same = reconciled.length === previous.feedback.length
    if (same) {
      for (let i = 0; i < reconciled.length; i++) {
        if (reconciled[i] !== previous.feedback[i]) {
          same = false
          break
        }
      }
    } else {
      same = false
    }
    return same ? previous.feedback : reconciled
  })()
  const selection = reconcileSelection(previous.selection, matches, document)
  let lineSelection: ReviewLineSelection | null = null
  const oldLine = previous.lineSelection
  const mapped = oldLine ? matches.previousToCurrent.get(oldLine.fileKey) : undefined
  if (oldLine && mapped) {
    const lineAnchor = {
      kind: "range" as const,
      fileKey: mapped.key,
      contentId: oldLine.contentId,
      side: oldLine.side,
      startLine: oldLine.line,
      endLine: oldLine.line,
      ownerHunkIndex: oldLine.hunkIndex,
      contextDigest: oldLine.contextDigest,
    }
    const reconciled = reconcileAnchor(lineAnchor, document)
    if (reconciled.resolution === "active" && reconciled.anchor.kind === "range") {
      lineSelection = {
        fileKey: reconciled.anchor.fileKey,
        hunkIndex: reconciled.anchor.ownerHunkIndex,
        side: reconciled.anchor.side,
        line: reconciled.anchor.startLine,
        contentId: reconciled.anchor.contentId,
        contextDigest: reconciled.anchor.contextDigest,
      }
    }
  }
  const expandedGaps = reconcileExpandedGaps(previous.expandedGaps, matches)
  const lineSelectionEqual = lineSelection === null && previous.lineSelection === null ||
    lineSelection !== null && previous.lineSelection !== null &&
    lineSelection.fileKey === previous.lineSelection.fileKey &&
    lineSelection.hunkIndex === previous.lineSelection.hunkIndex &&
    lineSelection.side === previous.lineSelection.side &&
    lineSelection.line === previous.lineSelection.line &&
    lineSelection.contentId === previous.lineSelection.contentId &&
    lineSelection.contextDigest === previous.lineSelection.contextDigest
  // Idempotent when generation and patch digest unchanged and all derived slices equal – avoids spurious revision bump for no-op reconciliation (I3)
  if (
    viewed === previous.viewed &&
    feedback === previous.feedback &&
    expandedGaps === previous.expandedGaps &&
    selection === previous.selection &&
    lineSelectionEqual &&
    document.generation.id === previous.document.generation.id &&
    document.aggregatePatchDigest === previous.document.aggregatePatchDigest
  ) {
    return previous
  }
  return reduceReviewState(previous, { type: "document/reconciled", document, viewed, feedback, selection, lineSelection, expandedGaps })
}

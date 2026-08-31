import type { InputRenderable, KeyEvent, MouseEvent, ScrollBoxRenderable, TextChunk, TextareaRenderable } from "@opentui/core"
import { StyledText, parseColor } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"
import { reviewHeaderLines } from "./header"
import { REVIEW_COMMANDS, resolveReviewCommand, reviewHelp } from "./command-catalog"
import { buildReviewSidebarEntries, getFileStateIcon, REVIEW_SIDEBAR_THEME, sidebarEntryStats, sidebarEntryStatsWidth } from "./review-sidebar"
import { toHunkReviewFiles } from "./hunk-review-model"
import { ReviewDiffPane } from "./components/ReviewDiffPane"
import { useReviewHighlights } from "./hooks/useReviewHighlights"
import { planReviewIntent } from "../../review/core/intents"
import { createFileAnchor, createLineSelection, createRangeAnchor, sideLinesForHunk } from "../../review/core/anchors"
import type { ReviewAnchor } from "../../review/core/types"
import { coverageForFile, sortedReviewFeedback, visibleReviewFiles } from "../../review/core/selectors"
import type { HunkDiffAddress } from "./hunk-diff-row-model"
import type { ReactReviewSession } from "./react-review-session"
import { cellWidth } from "../cell-width"
import { ANSI_GREEN, DEFAULT_FOREGROUND } from "../theme"
import { splitterGlyphs } from "../splitter"
export type ReviewWorkspaceAppProps = Readonly<{
  session: ReactReviewSession
}>

const REVIEW_SIDEBAR_DEFAULT_WIDTH = 30
const REVIEW_SIDEBAR_MIN_WIDTH = 20
const REVIEW_DIFF_MIN_CONTENT_WIDTH = 40
const REVIEW_DIFF_BORDER_WIDTH = 2
const REVIEW_RESIZE_BAR_WIDTH = 1
const REVIEW_SIDEBAR_VISIBILITY_WIDTH = 80


const COLORS = {
  plain: "#c5c8c6",
  dim: "#777777",
  strong: "#ffffff",
  viewed: "#b9ca4a",
  changed: "#f0c674",
  feedback: "#c397d8",
} as const

const colorCache = new Map<string, ReturnType<typeof parseColor>>()

function textChunk(text: string, style: keyof typeof COLORS): TextChunk {
  let fg = colorCache.get(COLORS[style])
  if (!fg) {
    fg = parseColor(COLORS[style])
    colorCache.set(COLORS[style], fg)
  }
  return { __isChunk: true, text, fg }
}

function headerText(state: ReviewState, width: number, error?: { title: string; detail: string }): StyledText {
  const lines = [...reviewHeaderLines(state, width)]
  if (error) lines.push([{ text: `! ${error.title}: ${error.detail}`, style: "dim" }])
  const chunks: TextChunk[] = []
  for (const [index, line] of lines.entries()) {
    if (index > 0) chunks.push(textChunk("\n", "plain"))
    for (const span of line) {
      chunks.push(textChunk(span.text, span.style === "strong" ? "strong" : span.style === "dim" ? "dim" : "plain"))
    }
  }
  return new StyledText(chunks)
}

function fitText(text: string, width: number, overflowMarker = "."): string {
  if (cellWidth(text) <= width) return text
  if (width <= 0) return ""
  if (width === 1) return overflowMarker.slice(0, 1)
  let out = ""
  let w = 0
  for (const ch of text) {
    const cw = cellWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out}${overflowMarker}`
}

function padText(text: string, width: number): string {
  const w = cellWidth(text)
  if (w >= width) return text
  return text + " ".repeat(width - w)
}

function reviewFooter(state: ReviewState, layout: "split" | "stack", focus: "stream" | "sidebar" | "filter"): string {
  const selected = state.selection.fileKey ?? "none"
  const entryFor = (id: string) => REVIEW_COMMANDS.find((candidate) => candidate.id === id)
  const keyFor = (id: string): string => {
    const value = entryFor(id)?.keys[0] ?? ""
    return value === "tab" ? "Tab" : value
  }
  const labelFor = (id: string): string => entryFor(id)?.hint ?? entryFor(id)?.title ?? id
  const command = (id: string, panel = false): string => `${keyFor(id)}${panel ? " " : ":"}${labelFor(id)}`
  const pair = (first: string, second: string): string => `${keyFor(first)}/${keyFor(second)}:${labelFor(first)}`
  const hints = [
    command("review.focusDiff", true),
    command("review.focusFiles", true),
    command("review.toggleFocus", true),
    `${command("review.layoutCycle", true)}(${layout})`,
    pair("review.moveDown", "review.moveUp"),
    pair("review.nextHunk", "review.prevHunk"),
    pair("review.nextFile", "review.prevFile"),
    pair("review.nextUnreviewed", "review.prevUnreviewed"),
    pair("review.nextFeedback", "review.prevFeedback"),
    command("review.focusFilter"),
    command("review.toggleRange"),
    command("review.createFeedback"),
    command("review.editFeedback"),
    command("review.deleteFeedback"),
    command("review.reanchorFeedback"),
    command("review.expandGap"),
    command("review.cycleFilterScope"),
    command("review.markViewed"),
    command("review.finishReview"),
    command("review.help"),
    command("review.close"),
  ]
  return `${hints.join(" | ")} | ${focus} — ${selected}`
}
function feedbackDraftText(state: ReviewState): string {
  const draft = state.draft
  if (!draft) return ""
  const file = state.document.files.find((candidate) => candidate.key === draft.anchor.fileKey)
  const anchor = file ? anchorLabel(file, draft.anchor) : `${draft.anchor.fileKey} file`
  return `Feedback composer — ${draft.kind}/${draft.severity} — ${anchor}\nCtrl-S save · Esc cancel`
}

function canShowReplacementDraft(state: ReviewState): boolean {
  const draft = state.draft
  if (!draft || draft.kind !== "suggestion" || draft.anchor.kind !== "range" || draft.anchor.side !== "new") return false
  const file = state.document.files.find((candidate) => candidate.key === draft.anchor.fileKey)
  return file !== undefined && file.source !== "binary" && file.source !== "too-large"
}

function suggestionReplacementInvalid(state: ReviewState): boolean {
  return state.draft?.kind === "suggestion" && (state.draft.replacement ?? "").trim().length === 0
}
function draftId(): string {
  try { return crypto.randomUUID() } catch { return Math.random().toString(36).slice(2) }
}
function keyName(key: KeyEvent): string {
  const parsed = key as unknown as { name?: string; key?: string; shift?: boolean }
  const raw = parsed.name ?? parsed.key ?? ""
  const lowerRaw = raw.toLowerCase()
  const normalized = lowerRaw === "return" || lowerRaw === "enter" ? "enter" : lowerRaw === "escape" ? "escape" : raw
  return parsed.shift === true && normalized.length === 1 ? normalized.toUpperCase() : normalized
}
function isPrintableFilterKey(name: string): boolean {
  // Focus shortcuts remain intentional controls even while the input is
  // focused; all other printable characters belong to filter editing.
  if (name === "0" || name === "1") return false
  const value = name === "space" ? " " : name
  if ([...value].length !== 1) return false
  const codePoint = value.codePointAt(0) ?? 0
  return codePoint >= 0x20 && codePoint !== 0x7f
}

function consume(event: KeyEvent): void {
  try { (event as unknown as { preventDefault?: () => void }).preventDefault?.() } catch {}
  try { (event as unknown as { stopPropagation?: () => void }).stopPropagation?.() } catch {}
}
type RangeStart = HunkDiffAddress

function anchorLabel(file: ReviewState["document"]["files"][number], anchor: ReviewAnchor): string {
  if (anchor.kind === "file") return `${file.path} file`
  const lineLabel = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`
  return `${file.path} ${anchor.side}:${lineLabel}`
}

function addressFromLineSelection(lineSelection: ReviewState["lineSelection"]): HunkDiffAddress | null {
  if (!lineSelection) return null
  return {
    fileKey: lineSelection.fileKey,
    hunkIndex: lineSelection.hunkIndex,
    side: lineSelection.side,
    line: lineSelection.line,
  }
}

function firstValidLineAddress(file: ReviewState["document"]["files"][number], hunkIndex: number): HunkDiffAddress | null {
  const hunk = file.hunks[hunkIndex]
  if (!hunk) return null
  const preferredSide = sideLinesForHunk(hunk, "new").length > 0 ? "new" : "old"
  const line = sideLinesForHunk(hunk, preferredSide)[0]?.lineNumber
  return line === undefined ? null : { fileKey: file.key, hunkIndex, side: preferredSide, line }
}
function nextUnreviewedFile(state: ReviewState, direction: "next" | "previous"): string | null {
  const files = state.document.files
  if (files.length === 0) return null
  const start = files.findIndex((file) => file.key === state.selection.fileKey)
  const origin = start < 0 ? (direction === "next" ? -1 : files.length) : start
  const step = direction === "next" ? 1 : -1
  for (let offset = 1; offset <= files.length; offset += 1) {
    const index = (origin + step * offset + files.length * 2) % files.length
    const file = files[index]
    if (file && coverageForFile(file, state.viewed) !== "viewed") return file.key
  }
  return null
}

type FeedbackTarget = Readonly<{ feedbackId: string; fileKey: string; hunkIndex: number }>

function feedbackTarget(state: ReviewState, direction: "next" | "previous", currentFeedbackId?: string | null): FeedbackTarget | null {
  const feedback = sortedReviewFeedback(state)
  if (feedback.length === 0) return null
  const currentIndex = currentFeedbackId
    ? feedback.findIndex((item) => item.id === currentFeedbackId)
    : feedback.findIndex((item) => item.anchor.fileKey === state.selection.fileKey)
  const origin = currentIndex < 0 ? (direction === "next" ? -1 : feedback.length) : currentIndex
  const step = direction === "next" ? 1 : -1
  const next = feedback[(origin + step + feedback.length) % feedback.length]
  if (!next) return null
  return {
    feedbackId: next.id,
    fileKey: next.anchor.fileKey,
    hunkIndex: next.anchor.kind === "range" ? next.anchor.ownerHunkIndex : 0,
  }
}
function fallbackSelectionIntent(
  state: ReviewState,
  unit: "file" | "hunk",
  direction: "next" | "previous",
): Parameters<typeof planReviewIntent>[1] | undefined {
  const visible = visibleReviewFiles(state)
  if (visible.some((file) => file.key === state.selection.fileKey)) return undefined
  const target = direction === "next" ? visible[0] : visible[visible.length - 1]
  if (!target) return undefined
  if (unit === "file") return { type: "selection/select-file", fileKey: target.key }
  return {
    type: "selection/viewport-anchor",
    fileKey: target.key,
    hunkIndex: direction === "next" ? 0 : Math.max(0, target.hunks.length - 1),
    ...(unit === "hunk" ? { reveal: "hunk" as const } : {}),
  }
}

export function ReviewWorkspaceApp({ session }: ReviewWorkspaceAppProps) {
  const terminal = useTerminalDimensions()
  const sessionVersion = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const controller: ReviewWorkspaceController = session.controller
  const active = session.active
  const onClose = session.onClose
  const finishDialog = session.finishDialog
  const [publishedState, setPublishedState] = useState<ReviewState | undefined>(() => controller.state)
  const state = controller.state ?? publishedState
  const [layoutMode, setLayoutMode] = useState<"auto" | "split" | "stack">("auto")
  const [sidebarWidthPreference, setSidebarWidthPreference] = useState(REVIEW_SIDEBAR_DEFAULT_WIDTH)
  const [resizeBarHovered, setResizeBarHovered] = useState(false)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [visibleFileKeys, setVisibleFileKeys] = useState<readonly string[]>([])
  const [focus, setFocus] = useState<"stream" | "sidebar" | "filter">("stream")
  const [rangeStart, setRangeStart] = useState<RangeStart | null>(null)
  const [pendingRangeAnchor, setPendingRangeAnchor] = useState<ReviewAnchor | null>(null)
  const localRangeIdentityRef = useRef<{ generationId: string; fileKey: string; contentId: string } | null>(null)
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(null)
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null)
  const [pendingDeleteFeedbackId, setPendingDeleteFeedbackId] = useState<string | null>(null)
  const [composerFocus, setComposerFocus] = useState<"body" | "replacement" | "controls">("body")
  const [composerControlIndex, setComposerControlIndex] = useState(0)
  const [reanchorFeedbackId, setReanchorFeedbackId] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const resizingSidebarRef = useRef(false)
  const resizeDraggedRef = useRef(false)
  const resizeReleaseSuppressionRef = useRef(false)
  const resizeReleaseCleanupTokenRef = useRef(0)
  const filterInputRef = useRef<InputRenderable | null>(null)
  const pendingDeleteFeedbackRef = useRef<string | null>(null)
  const composerBodyRef = useRef<TextareaRenderable | null>(null)
  const replacementRef = useRef<TextareaRenderable | null>(null)
  const finishSummaryRef = useRef<TextareaRenderable | null>(null)
  const finishSubmitRef = useRef(false)
  const expandedSourceRef = useRef<ReadonlyMap<string, readonly string[]>>(new Map())
  const dimensions = { width: Math.max(1, terminal.width), height: Math.max(1, terminal.height) }
  const maxSidebarWidth = Math.max(
    REVIEW_SIDEBAR_MIN_WIDTH,
    dimensions.width - REVIEW_RESIZE_BAR_WIDTH - REVIEW_DIFF_BORDER_WIDTH - REVIEW_DIFF_MIN_CONTENT_WIDTH,
  )
  const sidebarWidth = dimensions.width >= REVIEW_SIDEBAR_VISIBILITY_WIDTH
    ? Math.min(Math.max(sidebarWidthPreference, REVIEW_SIDEBAR_MIN_WIDTH), maxSidebarWidth)
    : 0
  const diffWidth = Math.max(
    1,
    dimensions.width - sidebarWidth - (sidebarWidth > 0 ? REVIEW_RESIZE_BAR_WIDTH : 0) - REVIEW_DIFF_BORDER_WIDTH,
  )
  const layout: "split" | "stack" = layoutMode === "auto" ? (diffWidth >= 64 ? "split" : "stack") : layoutMode
  const composerHeight = state?.draft ? (canShowReplacementDraft(state) ? 9 : 6) : 0
  const diffHeight = Math.max(1, dimensions.height - 4 - composerHeight - 2)
  const resizeBarHeight = Math.max(1, dimensions.height - 4 - composerHeight)
  const sidebarFocused = focus === "sidebar" || focus === "filter"
  const diffFocused = focus === "stream"
  const files = useMemo(() => state ? toHunkReviewFiles(visibleReviewFiles(state)) : [], [state?.document, state?.feedback, state?.filter, state?.viewed])
  const sidebarEntries = useMemo(() => state ? buildReviewSidebarEntries(state) : [], [state])
  const sidebarFileEntries = useMemo(() => sidebarEntries.filter((entry) => entry.kind === "file") as Extract<typeof sidebarEntries[number], { kind: "file" }>[], [sidebarEntries])
  const sidebarStatsWidth = useMemo(() => Math.max(0, ...sidebarFileEntries.map((entry) => sidebarEntryStatsWidth(entry))), [sidebarFileEntries])
  const sidebarTextWidth = Math.max(8, sidebarWidth - 2)
  const expandedSourceByGap = useMemo(() => {
    const next = typeof controller.getExpandedSourceByGap === "function" ? controller.getExpandedSourceByGap() : new Map<string, readonly string[]>()
    const previous = expandedSourceRef.current
    if (previous.size === next.size && [...next].every(([key, lines]) => previous.get(key) === lines)) return previous
    expandedSourceRef.current = next
    return next
  }, [controller, sessionVersion])
  useEffect(() => {
    if (!active || !state || typeof controller.ensureExpandedGapSource !== "function") return
    for (const gap of state.expandedGaps) {
      if (!gap.expanded || expandedSourceByGap.has(`${gap.fileKey}:${gap.gapId}`)) continue
      void controller.ensureExpandedGapSource(gap.fileKey, gap.gapId).catch(() => {})
    }
  }, [active, controller, expandedSourceByGap, sessionVersion, state?.expandedGaps])
  const highlightResult = useReviewHighlights({
    files,
    ...(state ? { state, selectedFileKey: state.selection.fileKey } : {}),
    requestedFileKeys: visibleFileKeys,
    appearance: "dark",
    enabled: active,
  })
  const onVisibleFileKeysChange = useCallback((keys: readonly string[]) => {
    setVisibleFileKeys((current) => current.length === keys.length && current.every((key, index) => key === keys[index]) ? current : [...keys])
  }, [])
  const updateSidebarWidth = useCallback((event: MouseEvent) => {
    const nextWidth = Math.min(Math.max(Math.floor(event.x), REVIEW_SIDEBAR_MIN_WIDTH), maxSidebarWidth)
    setSidebarWidthPreference((current) => current === nextWidth ? current : nextWidth)
  }, [maxSidebarWidth])
  const beginSidebarResize = useCallback(() => {
    resizeReleaseCleanupTokenRef.current += 1
    resizeReleaseSuppressionRef.current = false
    resizeDraggedRef.current = false
    resizingSidebarRef.current = true
    setResizingSidebar(true)
  }, [])
  const endSidebarResize = useCallback(() => {
    const dragged = resizeDraggedRef.current
    resizeDraggedRef.current = false
    resizingSidebarRef.current = false
    setResizingSidebar(false)
    if (!dragged) {
      resizeReleaseSuppressionRef.current = false
      return
    }
    resizeReleaseSuppressionRef.current = true
    const cleanupToken = resizeReleaseCleanupTokenRef.current + 1
    resizeReleaseCleanupTokenRef.current = cleanupToken
    queueMicrotask(() => {
      if (resizeReleaseCleanupTokenRef.current === cleanupToken) resizeReleaseSuppressionRef.current = false
    })
  }, [])
  const handleSidebarResizeMouse = useCallback((event: MouseEvent) => {
    if (resizeReleaseSuppressionRef.current) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!resizingSidebarRef.current) return
    if (event.type === "drag" || event.type === "drag-end") {
      resizeDraggedRef.current = true
      updateSidebarWidth(event)
    } else if (event.type === "up") {
      updateSidebarWidth(event)
      endSidebarResize()
    }
    event.preventDefault()
    event.stopPropagation()
  }, [endSidebarResize, updateSidebarWidth])
  const resetSidebarResize = useCallback(() => {
    resizingSidebarRef.current = false
    resizeDraggedRef.current = false
    resizeReleaseSuppressionRef.current = false
    resizeReleaseCleanupTokenRef.current += 1
    setResizingSidebar(false)
    setResizeBarHovered(false)
  }, [])
  useLayoutEffect(() => {
    if (active) return
    setRangeStart(null)
    setPendingRangeAnchor(null)
    setSelectedFeedbackId(null)
    setEditingFeedbackId(null)
    setPendingDeleteFeedbackId(null)
    setReanchorFeedbackId(null)
    setFeedbackMessage(null)
    setComposerFocus("body")
    setComposerControlIndex(0)
    pendingDeleteFeedbackRef.current = null
    setHelpOpen(false)
    setFocus("stream")
    resetSidebarResize()
  }, [active, resetSidebarResize])
  useLayoutEffect(() => {
    if (sidebarWidth > 0) return
    resetSidebarResize()
  }, [resetSidebarResize, sidebarWidth])

  useEffect(() => {
    if (sidebarWidth === 0 && focus !== "stream") setFocus("stream")
  }, [focus, sidebarWidth])
  useLayoutEffect(() => {
    if (!state?.draft) return
    if (composerFocus === "body") {
      composerBodyRef.current?.focus()
      replacementRef.current?.blur()
    } else if (composerFocus === "replacement" && canShowReplacementDraft(state)) {
      composerBodyRef.current?.blur()
      replacementRef.current?.focus()
    } else {
      composerBodyRef.current?.blur()
      replacementRef.current?.blur()
    }
  }, [composerFocus, state?.draft])
  useEffect(() => {
    const pending = pendingRangeAnchor
    const start = rangeStart
    if (!start && !pending) {
      localRangeIdentityRef.current = null
      return
    }
    const localFileKey = start?.fileKey ?? pending?.fileKey
    const file = localFileKey ? state?.document.files.find((candidate) => candidate.key === localFileKey) : undefined
    const identity = file && state
      ? { generationId: state.document.generation.id, fileKey: file.key, contentId: file.contentId }
      : null
    const previous = localRangeIdentityRef.current
    const line = state?.lineSelection
    const lineMatchesStart = start !== null
      && line !== null
      && line !== undefined
      && line.fileKey === start.fileKey
      && line.hunkIndex === start.hunkIndex
      && line.side === start.side
      && line.contentId === identity?.contentId
    const changedDocument = previous !== null
      && (identity === null
        || previous.generationId !== identity.generationId
        || (previous.fileKey === identity.fileKey && previous.contentId !== identity.contentId))
    if (changedDocument || !identity || (start !== null && !lineMatchesStart) || (start === null && (!line || line.fileKey !== pending?.fileKey))) {
      localRangeIdentityRef.current = null
      setRangeStart(null)
      setPendingRangeAnchor(null)
      return
    }
    localRangeIdentityRef.current = identity
  }, [pendingRangeAnchor, rangeStart, state?.document, state?.lineSelection])
  const toggleGap = useCallback((fileKey: string, gapId: string) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    if (typeof controller.expandGap !== "function") return
    void controller.expandGap(fileKey, gapId).catch(() => {})
  }, [controller])
  const submitFinish = useCallback(() => {
    if (finishSubmitRef.current) return
    finishSubmitRef.current = true
    const submittedController = controller
    void finishDialog.submit().finally(() => {
      finishSubmitRef.current = false
      if (session.active && session.controller === submittedController) session.invalidate()
    })
  }, [controller, finishDialog, session])
  const saveDraft = useCallback(() => {
    const current = controller.state
    const draft = current?.draft
    if (!current || !draft) return
    if (suggestionReplacementInvalid(current)) {
      setFeedbackMessage("Suggestion replacement cannot be empty.")
      session.invalidate()
      return
    }
    try {
      if (editingFeedbackId) {
        const existing = current.feedback.find((feedback) => feedback.id === editingFeedbackId)
        if (!existing) {
          setEditingFeedbackId(null)
          return
        }
        const patch: { body?: string; severity?: "comment" | "blocking"; replacement?: string } = {}
        if (draft.body !== existing.body) patch.body = draft.body
        if (draft.severity !== existing.severity) patch.severity = draft.severity
        if (draft.replacement !== undefined && draft.replacement !== existing.replacement) patch.replacement = draft.replacement
        if (Object.keys(patch).length > 0) {
          controller.dispatch(planReviewIntent(current, { type: "feedback/edit", id: existing.id, ...patch, updatedAt: new Date().toISOString() }))
        }
        const latest = controller.state
        if (latest?.draft) controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" }))
        setEditingFeedbackId(null)
      } else {
        controller.dispatch(planReviewIntent(current, { type: "feedback/create", id: draftId(), createdAt: new Date().toISOString() }))
      }
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
      setComposerFocus("body")
      setFeedbackMessage(null)
      session.invalidate()
    } catch {}
  }, [controller, editingFeedbackId, session])

  const deleteFeedback = useCallback((feedbackId: string) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const current = controller.state
    if (!current?.feedback.some((feedback) => feedback.id === feedbackId)) return
    if (pendingDeleteFeedbackRef.current !== feedbackId) {
      pendingDeleteFeedbackRef.current = feedbackId
      setPendingDeleteFeedbackId(feedbackId)
      session.invalidate()
      return
    }
    try {
      controller.dispatch(planReviewIntent(current, { type: "feedback/delete", id: feedbackId }))
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
      if (selectedFeedbackId === feedbackId) setSelectedFeedbackId(null)
      session.invalidate()
    } catch {}
  }, [controller, selectedFeedbackId, session])

  const reanchorFeedback = useCallback((feedbackId: string) => {
    const current = controller.state
    const feedback = current?.feedback.find((entry) => entry.id === feedbackId)
    if (!current || !feedback) return
    const fileKey = current.selection.fileKey
    const file = fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
    if (!file) {
      setFeedbackMessage("Select the file containing the feedback before re-anchoring.")
      setReanchorFeedbackId(feedbackId)
      session.invalidate()
      return
    }

    const selectedAddress = addressFromLineSelection(current.lineSelection)
    const pending = pendingRangeAnchor
      && pendingRangeAnchor.fileKey === file.key
      && pendingRangeAnchor.contentId === file.contentId
      ? pendingRangeAnchor
      : null
    let anchor: ReviewAnchor | null = null
    if (feedback.kind === "suggestion" || feedback.anchor.kind === "range") {
      anchor = pending
      if (!anchor && selectedAddress && selectedAddress.fileKey === file.key) {
        try {
          anchor = createRangeAnchor(file, {
            side: selectedAddress.side,
            startLine: selectedAddress.line,
            endLine: selectedAddress.line,
          })
        } catch {}
      }
    } else if (pending) {
      anchor = pending
    } else if (selectedAddress && selectedAddress.fileKey === file.key) {
      try {
        anchor = createRangeAnchor(file, {
          side: selectedAddress.side,
          startLine: selectedAddress.line,
          endLine: selectedAddress.line,
        })
      } catch {}
    } else {
      anchor = createFileAnchor(file)
    }
    if (!anchor || (feedback.kind === "suggestion" && (anchor.kind !== "range" || anchor.side !== "new"))) {
      setReanchorFeedbackId(feedbackId)
      setFeedbackMessage(
        feedback.kind === "suggestion"
          ? "Select a current new-side line or range, then press a to re-anchor this suggestion."
          : "Select a current diff line or range, then press a to re-anchor this feedback.",
      )
      session.invalidate()
      return
    }
    try {
      controller.dispatch(planReviewIntent(current, { type: "feedback/reanchor", id: feedbackId, anchor, updatedAt: new Date().toISOString() }))
      setReanchorFeedbackId(null)
      setFeedbackMessage(null)
      setPendingRangeAnchor(null)
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
      session.invalidate()
    } catch {
      setReanchorFeedbackId(feedbackId)
      setFeedbackMessage("The selected source is not a valid anchor for this feedback.")
      session.invalidate()
    }
  }, [controller, pendingRangeAnchor, session])

  const editFeedback = useCallback((feedbackId: string) => {
    const current = controller.state
    const feedback = current?.feedback.find((entry) => entry.id === feedbackId)
    if (!current || !feedback) return
    try {
      controller.dispatch(planReviewIntent(current, {
        type: "feedback/start-draft",
        anchor: feedback.anchor,
        kind: feedback.kind,
        severity: feedback.severity,
        body: feedback.body,
        ...(feedback.replacement !== undefined ? { replacement: feedback.replacement } : {}),
      }))
      setEditingFeedbackId(feedbackId)
      setSelectedFeedbackId(feedbackId)
      setComposerFocus("body")
      setComposerControlIndex(0)
      setFeedbackMessage(null)
      session.invalidate()
    } catch {}
  }, [controller, session])
  const selectFeedback = useCallback((feedbackId: string) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const current = controller.state
    const feedback = current?.feedback.find((entry) => entry.id === feedbackId)
    if (!current || !feedback) return
    setRangeStart(null)
    setPendingRangeAnchor(null)
    setSelectedFeedbackId(feedbackId)
    pendingDeleteFeedbackRef.current = null
    setPendingDeleteFeedbackId(null)
    const file = current.document.files.find((candidate) => candidate.key === feedback.anchor.fileKey)
    if (!file) return
    try {
      controller.dispatch(planReviewIntent(current, { type: "selection/select-file", fileKey: file.key }))
      if (feedback.anchor.kind === "range") {
        const latest = controller.state
        if (latest) controller.dispatch(planReviewIntent(latest, { type: "selection/viewport-anchor", fileKey: file.key, hunkIndex: feedback.anchor.ownerHunkIndex, reveal: "hunk" }))
      }
      setFocus("stream")
      session.invalidate()
    } catch {}
  }, [controller, session])
  const selectDiffAddress = useCallback((address: HunkDiffAddress) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const current = controller.state
    if (!current) return
    const file = current.document.files.find((candidate) => candidate.key === address.fileKey)
    if (!file) return
    try {
      const selection = createLineSelection(file, {
        hunkIndex: address.hunkIndex,
        side: address.side,
        line: address.line,
      })
      controller.dispatch(planReviewIntent(current, { type: "selection/set-line", selection }))
      setFocus("stream")
      const previousRange = rangeStart
      if (!previousRange
        || previousRange.fileKey !== address.fileKey
        || previousRange.hunkIndex !== address.hunkIndex
        || previousRange.side !== address.side) {
        setRangeStart(address)
        setPendingRangeAnchor(null)
      } else {
        try {
          setPendingRangeAnchor(createRangeAnchor(file, {
            side: address.side,
            startLine: Math.min(previousRange.line, address.line),
            endLine: Math.max(previousRange.line, address.line),
          }))
          setRangeStart(null)
        } catch {
          setRangeStart(address)
          setPendingRangeAnchor(null)
        }
      }
      setFeedbackMessage(null)
      session.invalidate()
    } catch {}
  }, [controller, rangeStart, session])
  const executeCommand = useCallback((commandId: string, payload?: unknown): boolean => {
    const current = controller.state
    if (commandId === "review.focusDiff") {
      setFocus("stream")
      return true
    }
    if (commandId === "review.focusFiles") {
      setFocus(sidebarWidth > 0 ? "sidebar" : "stream")
      return true
    }
    if (commandId === "review.toggleFocus") {
      setFocus((currentFocus) => sidebarWidth === 0
        ? "stream"
        : currentFocus === "stream" ? "sidebar" : currentFocus === "sidebar" ? "filter" : "stream")
      return true
    }
    if (commandId === "review.focusFilter") {
      if (sidebarWidth > 0) {
        setFocus("filter")
        filterInputRef.current?.focus()
      } else {
        setFocus("stream")
      }
      return true
    }
    if (commandId === "review.layoutCycle") {
      setLayoutMode((currentMode) => {
        const currentLayout = currentMode === "auto" ? (diffWidth >= 64 ? "split" : "stack") : currentMode
        if (currentLayout === "split") return "stack"
        return diffWidth >= 64 ? "auto" : "split"
      })
      return true
    }
    if (commandId === "review.help") {
      setHelpOpen(true)
      return true
    }
    if (commandId === "review.close") {
      onClose()
      return true
    }
    if (!current) return false
    if (commandId === "review.moveDown" || commandId === "review.moveUp") {
      const direction = commandId === "review.moveDown" ? "next" : "previous"
      if (focus === "sidebar") {
        try { controller.dispatch(planReviewIntent(current, { type: "selection/move", unit: "file", direction })) } catch {}
        setRangeStart(null)
        setPendingRangeAnchor(null)
      } else {
        const selected = current.lineSelection
        if (!selected) {
          const file = current.selection.fileKey
            ? current.document.files.find((candidate) => candidate.key === current.selection.fileKey)
            : undefined
          const address = file ? firstValidLineAddress(file, current.selection.hunkIndex) : null
          if (address && file) {
            try {
              const lineSelection = createLineSelection(file, address)
              controller.dispatch(planReviewIntent(current, { type: "selection/set-line", selection: lineSelection }))
              setRangeStart(null)
              setPendingRangeAnchor(null)
            } catch {}
          }
        } else {
          try {
            controller.dispatch(planReviewIntent(current, { type: "selection/move-line", direction }))
          } catch {}
          // Semantic j/k moves stay within the active side/hunk. Keep the
          // first endpoint so a subsequent v can complete the range.
          setPendingRangeAnchor(null)
        }
        diffScrollRef.current?.scrollBy(direction === "next" ? 1 : -1)
      }
      return true
    }
    const navigation: Record<string, { unit: "file" | "hunk"; direction: "next" | "previous" }> = {
      "review.nextFile": { unit: "file", direction: "next" },
      "review.prevFile": { unit: "file", direction: "previous" },
      "review.nextHunk": { unit: "hunk", direction: "next" },
      "review.prevHunk": { unit: "hunk", direction: "previous" },
    }
    const movement = navigation[commandId]
    if (movement) {
      try {
        const before = current.selection
        controller.dispatch(planReviewIntent(current, { type: "selection/move", unit: movement.unit, direction: movement.direction }))
        const after = controller.state
        if (after?.selection.fileKey === before.fileKey && after.selection.hunkIndex === before.hunkIndex) {
          const fallback = fallbackSelectionIntent(current, movement.unit, movement.direction)
          if (fallback && controller.state) controller.dispatch(planReviewIntent(controller.state, fallback))
        }
      } catch {}
      setRangeStart(null)
      setPendingRangeAnchor(null)
      return true
    }
    if (commandId === "review.nextUnreviewed" || commandId === "review.prevUnreviewed") {
      const target = nextUnreviewedFile(current, commandId === "review.nextUnreviewed" ? "next" : "previous")
      if (target) {
        try { controller.dispatch(planReviewIntent(current, { type: "selection/select-file", fileKey: target })) } catch {}
      }
      setRangeStart(null)
      setPendingRangeAnchor(null)
      return true
    }
    if (commandId === "review.nextFeedback" || commandId === "review.prevFeedback") {
      const target = feedbackTarget(current, commandId === "review.nextFeedback" ? "next" : "previous", selectedFeedbackId)
      if (target) {
        setSelectedFeedbackId(target.feedbackId)
        try { controller.dispatch(planReviewIntent(current, { type: "selection/viewport-anchor", fileKey: target.fileKey, hunkIndex: target.hunkIndex, reveal: "hunk" })) } catch {}
      }
      setRangeStart(null)
      setPendingRangeAnchor(null)
      return true
    }
    if (commandId === "review.markViewed") {
      const fileKey = current.selection.fileKey
      if (fileKey) {
        try { controller.dispatch(planReviewIntent(current, { type: "viewed/mark", fileKey, viewedAt: new Date().toISOString() })) } catch {}
      }
      return true
    }
    if (commandId === "review.toggleRange") {
      const lineAddress = addressFromLineSelection(current.lineSelection)
      const file = lineAddress ? current.document.files.find((candidate) => candidate.key === lineAddress.fileKey) : undefined
      if (lineAddress && file) {
        if (!rangeStart) {
          setRangeStart(lineAddress)
          setPendingRangeAnchor(null)
        } else if (
          rangeStart.fileKey === lineAddress.fileKey
          && rangeStart.hunkIndex === lineAddress.hunkIndex
          && rangeStart.side === lineAddress.side
        ) {
          try {
            setPendingRangeAnchor(createRangeAnchor(file, {
              side: lineAddress.side,
              startLine: Math.min(rangeStart.line, lineAddress.line),
              endLine: Math.max(rangeStart.line, lineAddress.line),
            }))
            setRangeStart(null)
          } catch {
            setPendingRangeAnchor(null)
          }
        } else {
          setRangeStart(lineAddress)
          setPendingRangeAnchor(null)
        }
      }
      return true
    }
    if (commandId === "review.createFeedback") {
      if (focus !== "stream" || current.draft) return false
      const lineAddress = addressFromLineSelection(current.lineSelection)
      const fileKey = current.selection.fileKey
      const file = fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
      if (file) {
        let anchor: ReviewAnchor = createFileAnchor(file)
        if (pendingRangeAnchor && pendingRangeAnchor.fileKey === file.key && pendingRangeAnchor.contentId === file.contentId) {
          anchor = pendingRangeAnchor
        } else if (lineAddress && lineAddress.fileKey === file.key) {
          try {
            anchor = createRangeAnchor(file, {
              side: lineAddress.side,
              startLine: lineAddress.line,
              endLine: lineAddress.line,
            })
          } catch {}
        }
        try {
          controller.dispatch(planReviewIntent(current, {
            type: "feedback/start-draft",
            anchor,
            kind: "note",
            severity: "comment",
            body: "",
          }))
          setEditingFeedbackId(null)
          setComposerFocus("body")
          setComposerControlIndex(0)
          pendingDeleteFeedbackRef.current = null
          setPendingDeleteFeedbackId(null)
          setFeedbackMessage(null)
          if (anchor.kind === "range") {
            setPendingRangeAnchor(null)
            setRangeStart(null)
          }
        } catch {}
      }
      return true
    }
    if (commandId === "review.editFeedback" && selectedFeedbackId) {
      editFeedback(selectedFeedbackId)
      return true
    }
    if (commandId === "review.deleteFeedback" && selectedFeedbackId) {
      deleteFeedback(selectedFeedbackId)
      return true
    }
    if (commandId === "review.reanchorFeedback" && selectedFeedbackId) {
      reanchorFeedback(selectedFeedbackId)
      return true
    }
    if (commandId === "review.expandGap") {
      const fileKey = current.selection.fileKey
      const file = fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
      const hunkIndex = Math.max(1, current.selection.hunkIndex)
      if (file?.hunks[hunkIndex]) void toggleGap(file.key, `before:${hunkIndex}`)
      return true
    }
    if (commandId === "review.cycleFilterScope") {
      const scopes = ["all", "unreviewed", "changed", "feedback"] as const
      const index = scopes.indexOf(current.filter.scope)
      const scope = scopes[(index + 1) % scopes.length] ?? "all"
      try { controller.dispatch(planReviewIntent(current, { type: "filter/set-scope", scope })) } catch {}
      return true
    }
    if (commandId === "review.finishReview") {
      if (current.draft || suggestionReplacementInvalid(current)) return false
      finishDialog.open()
      session.invalidate()
      return true
    }
    if (commandId === "review.selectFile" && typeof payload === "object" && payload !== null && "fileKey" in payload) {
      const selection = payload as { fileKey: string; nextFocus?: "stream" | "sidebar" }
      selectFile(selection.fileKey, selection.nextFocus ?? "stream")
      return true
    }
    if (commandId === "review.selectDiffLine" && payload && typeof payload === "object") {
      selectDiffAddress(payload as HunkDiffAddress)
      return true
    }
    if (commandId === "review.selectFeedback" && typeof payload === "string") {
      selectFeedback(payload)
      return true
    }
    return false
  }, [controller, deleteFeedback, diffWidth, editFeedback, finishDialog, focus, onClose, pendingRangeAnchor, rangeStart, reanchorFeedback, selectedFeedbackId, selectFeedback, selectDiffAddress, session, sidebarWidth, toggleGap])

  const handleKey = useCallback((event: KeyEvent) => {
    if (!active) return
    const name = keyName(event)
    const current = controller.state

    // Modal input owns these keys; they must not fall through to workspace commands.
    if (name === "escape") {
      if (current?.draft) {
        try { controller.dispatch(planReviewIntent(current, { type: "feedback/cancel-draft" })) } catch {}
        setEditingFeedbackId(null)
        setComposerFocus("body")
        setComposerControlIndex(0)
        session.invalidate()
        consume(event)
        return
      }
      if (finishDialog.isOpen()) {
        finishDialog.close()
        session.invalidate()
        consume(event)
        return
      }
      if (helpOpen) {
        setHelpOpen(false)
        consume(event)
        return
      }
      if (pendingDeleteFeedbackId) {
        pendingDeleteFeedbackRef.current = null
        setPendingDeleteFeedbackId(null)
        session.invalidate()
        consume(event)
        return
      }
      if (focus === "filter") {
        if (current && current.filter.query.length > 0) {
          try { controller.dispatch(planReviewIntent(current, { type: "filter/set-query", query: "" })) } catch {}
          session.invalidate()
        } else {
          filterInputRef.current?.blur()
          setFocus("stream")
        }
        consume(event)
        return
      }
      if (reanchorFeedbackId) {
        setReanchorFeedbackId(null)
        setFeedbackMessage(null)
        consume(event)
        return
      }
      if (rangeStart || pendingRangeAnchor) {
        setRangeStart(null)
        setPendingRangeAnchor(null)
        consume(event)
        return
      }
    }
    if (finishDialog.isOpen()) {
      if (event.ctrl && (name === "1" || name === "2" || name === "3")) {
        finishDialog.setDecision(name === "1" ? "comment" : name === "2" ? "approve" : "request-changes")
        session.invalidate()
        consume(event)
        return
      }
      if ((event.ctrl && name.toLowerCase() === "s") || name === "enter") {
        submitFinish()
        consume(event)
        return
      }
      return
    }
    if (helpOpen) {
      consume(event)
      return
    }
    if (current?.draft) {
      if (event.ctrl && name.toLowerCase() === "s") {
        saveDraft()
        consume(event)
      } else if (name === "tab") {
        const hasReplacement = canShowReplacementDraft(current)
        const backwards = event.shift === true
        if (composerFocus === "body") {
          if (backwards) {
            setComposerFocus("controls")
            setComposerControlIndex(5)
          } else {
            setComposerFocus(hasReplacement ? "replacement" : "controls")
          }
        } else if (composerFocus === "replacement") {
          setComposerFocus(backwards ? "body" : "controls")
          if (!backwards) setComposerControlIndex(0)
        } else {
          const controlCount = 6
          if (backwards && composerControlIndex > 0) {
            setComposerControlIndex((index) => index - 1)
          } else if (!backwards && composerControlIndex < controlCount - 1) {
            setComposerControlIndex((index) => index + 1)
          } else if (backwards) {
            setComposerFocus(hasReplacement ? "replacement" : "body")
            if (!hasReplacement) setComposerControlIndex(0)
          } else {
            setComposerFocus("body")
            setComposerControlIndex(0)
          }
        }
        consume(event)
      }
      return
    }
    if (focus === "filter" && name === "enter") {
      filterInputRef.current?.blur()
      setFocus("stream")
      consume(event)
      return
    }

    // The focused input owns printable text. Leave these events untouched so
    // OpenTUI can deliver them to the input instead of consuming a workspace
    // command such as layout (l) or Finish (R).
    if (
      focus === "filter"
      && !event.ctrl
      && !event.meta
      && !event.option
      && isPrintableFilterKey(name)
    ) return

    const normalized = name === "down" ? "ArrowDown" : name === "up" ? "ArrowUp" : name
    const command = resolveReviewCommand(normalized, focus)
    if (!command || (current && !command.available(current))) return
    if (executeCommand(command.id)) consume(event)
  }, [active, composerControlIndex, composerFocus, controller, executeCommand, finishDialog, focus, helpOpen, onClose, pendingDeleteFeedbackId, pendingRangeAnchor, rangeStart, reanchorFeedbackId, saveDraft, session, submitFinish])
  useKeyboard(handleKey)

  if (!state) {
    return (
      <box id="react-review-workspace" visible={active} style={{ width: "100%", height: "100%" }}>
        <text content="Loading branch review…" />
      </box>
    )
  }

  function selectFile(fileKey: string, nextFocus: "stream" | "sidebar" = "stream"): void {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const current = controller.state
      setRangeStart(null)
      setPendingRangeAnchor(null)
    if (!current) return
    try {
      controller.dispatch(planReviewIntent(current, { type: "selection/select-file", fileKey }))
      setSelectedFeedbackId(null)
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
      setFocus(nextFocus)
    } catch {
      // A stale click can race a generation refresh; the next published state rebinds the row.
    }
  }
  const suggestionAllowed = state.draft !== null
    && state.draft.anchor.kind === "range"
    && state.draft.anchor.side === "new"
    && state.document.files.some((file) => file.key === state.draft?.anchor.fileKey && file.source !== "binary" && file.source !== "too-large")
  const replacementInvalid = suggestionReplacementInvalid(state)
  const orphanedFeedback = state.feedback.filter((feedback) => !state.document.files.some((file) => file.key === feedback.anchor.fileKey))

  return (
    <box id="react-review-workspace" visible={active} onMouse={handleSidebarResizeMouse} style={{ position: "relative", width: "100%", height: "100%", flexDirection: "column", overflow: "hidden" }}>
      <box id="react-review-header" style={{ width: "100%", height: 3, flexShrink: 0 }}>
        <text content={headerText(state, dimensions.width, controller.error)} wrapMode="none" truncate={true} />
      </box>
      <box id="react-review-body" style={{ width: "100%", flexGrow: 1, flexDirection: "row", overflow: "hidden" }}>
        {sidebarWidth > 0 ? (<>
          <box
            id="react-review-sidebar"
            borderColor={sidebarFocused ? ANSI_GREEN : DEFAULT_FOREGROUND}
            title={`[1] Files ${sidebarFileEntries.length}/${state.document.files.length}`}
            titleColor={sidebarFocused ? ANSI_GREEN : DEFAULT_FOREGROUND}
            style={{ width: sidebarWidth, height: "100%", flexShrink: 0, border: true, flexDirection: "column" }}
            onMouseDown={() => setFocus("sidebar")}
          >
            <box id="review-file-filter" style={{ width: "100%", height: 1, flexShrink: 0, flexDirection: "row" }}>
              <text content="/ " fg={COLORS.dim} />
              <input
                id="review-file-filter-input"
                ref={filterInputRef}
                width={Math.max(4, sidebarWidth - 4)}
                value={state.filter.query}
                placeholder="filter files"
                focused={focus === "filter"}
                onMouseUp={() => {
                  if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
                  setFocus("filter")
                }}
                onInput={(query) => {
                  try { controller.dispatch(planReviewIntent(state, { type: "filter/set-query", query })) } catch {}
                }}
                onSubmit={() => {
                  filterInputRef.current?.blur()
                  setFocus("stream")
                }}
                onKeyDown={(event) => {
                  if (keyName(event) !== "escape") return
                  if (state.filter.query.length > 0) {
                    try { controller.dispatch(planReviewIntent(state, { type: "filter/set-query", query: "" })) } catch {}
                    session.invalidate()
                  } else {
                    filterInputRef.current?.blur()
                    setFocus("stream")
                  }
                  consume(event)
                }}
              />
            </box>
            <scrollbox
              id="react-review-sidebar-scrollbox"
              focused={focus === "sidebar"}
              width="100%"
              flexGrow={1}
              scrollY={true}
              viewportCulling={true}
              verticalScrollbarOptions={{ visible: false }}
              onMouseDown={() => setFocus("sidebar")}
            >
              <box style={{ width: "100%", flexDirection: "column" }}>
                {sidebarEntries.map((entry) => {
                  if (entry.kind === "group") {
                    return (
                      <box key={entry.id} id={`review-file-group:${entry.label}`} style={{ width: "100%", height: 1, backgroundColor: REVIEW_SIDEBAR_THEME.panel, paddingLeft: 1 }}>
                        <text fg={REVIEW_SIDEBAR_THEME.muted}>{fitText(entry.label, sidebarTextWidth)}</text>
                      </box>
                    )
                  }
                  const selected = entry.id === state.selection.fileKey
                  const rowBackground = selected ? REVIEW_SIDEBAR_THEME.panelAlt : REVIEW_SIDEBAR_THEME.panel
                  const stats = sidebarEntryStats(entry)
                  const { icon, color } = getFileStateIcon(entry)
                  const iconWidth = icon ? 2 : 0
                  const statsSectionWidth = sidebarStatsWidth > 0 ? sidebarStatsWidth + 1 : 0
                  const nameWidth = Math.max(1, sidebarTextWidth - 1 - iconWidth - statsSectionWidth)
                  return (
                    <box
                      key={entry.id}
                      id={`review-file-row:${entry.id}`}
                      style={{ width: "100%", height: 1, backgroundColor: rowBackground, flexDirection: "row" }}
                      onMouseDown={() => setFocus("sidebar")}
                      onMouseUp={() => { executeCommand("review.selectFile", { fileKey: entry.id, nextFocus: "sidebar" }) }}
                    >
                      <box style={{ width: 1, height: 1, backgroundColor: selected ? REVIEW_SIDEBAR_THEME.accent : rowBackground }} />
                      <box style={{ flexGrow: 1, height: 1, paddingLeft: 0, flexDirection: "row", backgroundColor: rowBackground }}>
                        {icon ? <text fg={color}>{`${icon} `}</text> : null}
                        <text fg={REVIEW_SIDEBAR_THEME.text}>{padText(fitText(entry.name, nameWidth), nameWidth)}</text>
                        {statsSectionWidth > 0 ? (
                          <box style={{ width: statsSectionWidth, height: 1, flexDirection: "row", justifyContent: "flex-end", backgroundColor: rowBackground }}>
                            {stats.map((stat, index) => (
                              <box key={`${entry.id}:${stat.kind}`} style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground }}>
                                {index > 0 ? <text fg={selected ? REVIEW_SIDEBAR_THEME.text : REVIEW_SIDEBAR_THEME.muted}> </text> : null}
                                <text
                                  fg={
                                    stat.kind === "agent-comment"
                                      ? REVIEW_SIDEBAR_THEME.noteBorder
                                      : stat.kind === "addition"
                                        ? REVIEW_SIDEBAR_THEME.badgeAdded
                                        : REVIEW_SIDEBAR_THEME.badgeRemoved
                                  }
                                >
                                  {stat.text}
                                </text>
                              </box>
                            ))}
                          </box>
                        ) : null}
                      </box>
                    </box>
                  )
                })}
              </box>
            </scrollbox>
          </box>
          <box
            id="review-pane-resize-bar"
            style={{ width: REVIEW_RESIZE_BAR_WIDTH, height: "100%", flexShrink: 0 }}
            onMouseOver={() => setResizeBarHovered(true)}
            onMouseOut={() => setResizeBarHovered(false)}
            onMouseDown={(event) => {
              beginSidebarResize()
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseDrag={(event) => {
              if (!resizingSidebarRef.current) return
              resizeDraggedRef.current = true
              updateSidebarWidth(event)
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseDragEnd={(event) => {
              if (resizingSidebarRef.current) {
                resizeDraggedRef.current = true
                updateSidebarWidth(event)
              }
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseUp={(event) => {
              if (resizingSidebarRef.current) updateSidebarWidth(event)
              endSidebarResize()
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <text
              id="review-pane-resize-bar-glyphs"
              selectable={false}
              content={splitterGlyphs("vertical", REVIEW_RESIZE_BAR_WIDTH, resizeBarHeight, resizeBarHovered || resizingSidebar)}
              fg={resizeBarHovered || resizingSidebar ? ANSI_GREEN : DEFAULT_FOREGROUND}
              width={REVIEW_RESIZE_BAR_WIDTH}
              height="100%"
              wrapMode="none"
              truncate={true}
            />
          </box>
        </>) : null}
        <box
          id="react-review-diff"
          borderColor={diffFocused ? ANSI_GREEN : DEFAULT_FOREGROUND}
          title={`[0] Diff — ${layout}`}
          titleColor={diffFocused ? ANSI_GREEN : DEFAULT_FOREGROUND}
          style={{ width: "100%", height: "100%", flexGrow: 1, border: true, minWidth: 0 }}
          onMouseDown={() => setFocus("stream")}
        >
          <ReviewDiffPane
            files={files}
            state={state}
            layout={layout}
            width={diffWidth}
            height={diffHeight}
            focused={focus === "stream"}
            scrollRef={diffScrollRef}
            selectedFileKey={state.selection.fileKey}
            selectedHunkIndex={state.selection.hunkIndex}
            selectedFileRevealToken={state.reveal.fileTopRequestToken}
            selectedHunkRevealToken={state.reveal.hunkToken}
            highlightByFileKey={highlightResult.highlights}
            onVisibleFileKeysChange={onVisibleFileKeysChange}
            expandedSourceByGap={expandedSourceByGap}
            onToggleGap={toggleGap}
            onSelectFile={(fileKey) => { executeCommand("review.selectFile", { fileKey, nextFocus: "stream" }) }}
            onSelectFeedback={(feedbackId) => { executeCommand("review.selectFeedback", feedbackId) }}
            onSelectDiffAddress={(address) => { executeCommand("review.selectDiffLine", address) }}
            selectedFeedbackId={selectedFeedbackId}
            onViewportChange={session.setViewportStart}
          />
        </box>
      </box>
      {orphanedFeedback.length > 0 ? (
        <box
          id="review-orphaned-feedback"
          style={{ position: "absolute", left: 1, bottom: 1, width: Math.max(20, dimensions.width - 2), height: Math.min(4, orphanedFeedback.length), zIndex: 50, border: true, flexDirection: "column", backgroundColor: "#202020" }}
        >
          {orphanedFeedback.slice(0, 4).map((feedback) => (
              <box key={feedback.id} style={{ width: "100%", height: 1, flexDirection: "row" }} onMouseUp={() => {
                if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
                executeCommand("review.selectFeedback", feedback.id)
              }}>
              <text
                content={`${feedback.resolution} feedback ${feedback.id} — ${feedback.anchor.kind === "range" ? `${feedback.anchor.side}:${feedback.anchor.startLine === feedback.anchor.endLine ? feedback.anchor.startLine : `${feedback.anchor.startLine}-${feedback.anchor.endLine}`}` : "file"} — [a]nchor`}
                wrapMode="none"
                truncate={true}
              />
              <box id={`review-delete-feedback:${feedback.id}`} onMouseUp={() => {
                if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
                deleteFeedback(feedback.id)
              }}>
                <text content={pendingDeleteFeedbackId === feedback.id ? "[delete again]" : "[delete]"} wrapMode="none" truncate={true} />
              </box>
              <box id={`review-reanchor-feedback:${feedback.id}`} onMouseUp={() => {
                if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
                reanchorFeedback(feedback.id)
              }}>
                <text content="[re-anchor]" wrapMode="none" truncate={true} />
              </box>
        </box>
          ))}
        </box>
      ) : null}
      {feedbackMessage ? (
        <box id="review-feedback-message" style={{ position: "absolute", left: 1, bottom: orphanedFeedback.length > 0 ? Math.min(5, orphanedFeedback.length + 1) : 1, width: Math.max(20, dimensions.width - 2), height: 1, zIndex: 55, backgroundColor: "#202020" }}>
          <text content={feedbackMessage} wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {state.draft ? (
        <box id="review-feedback-composer" style={{ width: "100%", height: composerHeight, flexShrink: 0, border: true, flexDirection: "column" }}>
          <text content={feedbackDraftText(state)} wrapMode="none" truncate={true} />
          <box id="review-feedback-controls" style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <box id="review-feedback-kind-note" style={composerFocus === "controls" && composerControlIndex === 0 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              setComposerFocus("controls")
              setComposerControlIndex(0)
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", kind: "note" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.kind === "note" ? "[Note]" : " Note "} />
            </box>
            <box id="review-feedback-kind-suggestion" style={composerFocus === "controls" && composerControlIndex === 1 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              setComposerFocus("controls")
              setComposerControlIndex(1)
              const latest = controller.state
              if (!latest?.draft || !suggestionAllowed) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", kind: "suggestion" }))
                setFeedbackMessage(null)
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.kind === "suggestion" ? "[Suggestion]" : " Suggestion "} />
            </box>
            <box id="review-feedback-severity-comment" style={composerFocus === "controls" && composerControlIndex === 2 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              setComposerFocus("controls")
              setComposerControlIndex(2)
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", severity: "comment" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.severity === "comment" ? "[Comment]" : " Comment "} />
            </box>
            <box id="review-feedback-severity-blocking" style={composerFocus === "controls" && composerControlIndex === 3 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              setComposerFocus("controls")
              setComposerControlIndex(3)
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", severity: "blocking" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.severity === "blocking" ? "[Blocking]" : " Blocking "} />
            </box>
            <box id="review-feedback-save" style={composerFocus === "controls" && composerControlIndex === 4 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current || replacementInvalid) return
              setComposerFocus("controls")
              setComposerControlIndex(4)
              saveDraft()
            }}>
              <text content={replacementInvalid ? "[Save disabled]" : " [Save] "} />
            </box>
            <box id="review-feedback-cancel" style={composerFocus === "controls" && composerControlIndex === 5 ? { backgroundColor: "#365f8a" } : {}} onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              setComposerFocus("controls")
              setComposerControlIndex(5)
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" }))
                setEditingFeedbackId(null)
                setComposerFocus("body")
                session.invalidate()
              } catch {}
            }}>
              <text content=" [Cancel] " />
            </box>
          </box>
          <textarea
            id="review-feedback-body"
            ref={composerBodyRef}
            width="100%"
            height={2}
            initialValue={state.draft.body}
            focused={composerFocus === "body"}
            keyBindings={[{ name: "escape", action: "submit" }]}
            onSubmit={() => {
              const latest = controller.state
              if (latest?.draft) {
                try { controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" })) } catch {}
                setEditingFeedbackId(null)
                setComposerFocus("body")
                setComposerControlIndex(0)
                session.invalidate()
              }
            }}
            onKeyDown={(event) => {
              const name = keyName(event)
              const latest = controller.state
              if (name === "escape" && latest?.draft) {
                try { controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" })) } catch {}
                setEditingFeedbackId(null)
                setComposerFocus("body")
                setComposerControlIndex(0)
                session.invalidate()
                consume(event)
              } else if (event.ctrl && name.toLowerCase() === "s" && latest?.draft) {
                saveDraft()
                consume(event)
              }
            }}
            onContentChange={() => {
              const body = composerBodyRef.current?.plainText ?? ""
              const latest = controller.state
              if (!latest?.draft || latest.draft.body === body) return
              try { controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", body })) } catch {}
            }}
          />
          {canShowReplacementDraft(state) ? (
            <>
              <textarea
                id="review-feedback-replacement"
                ref={replacementRef}
                width="100%"
                height={2}
                initialValue={state.draft.replacement ?? ""}
                focused={composerFocus === "replacement"}
                wrapMode="char"
                placeholder="Replacement text"
                onContentChange={() => {
                  const replacement = replacementRef.current?.plainText ?? ""
                  const latest = controller.state
                  if (!latest?.draft || latest.draft.replacement === replacement) return
                  try {
                    controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", replacement }))
                    session.invalidate()
                  } catch {}
                }}
              />
              {replacementInvalid ? <text id="review-feedback-replacement-error" content="Invalid replacement: enter non-whitespace text." wrapMode="none" truncate={true} /> : null}
            </>
          ) : null}
        </box>
      ) : null}
      {helpOpen ? (
        <box
          id="review-help-dialog"
          style={{ position: "absolute", left: Math.max(1, Math.floor(dimensions.width / 10)), top: 2, width: Math.max(50, Math.floor(dimensions.width * 4 / 5)), height: Math.min(26, Math.max(14, dimensions.height - 4)), zIndex: 70, border: true, flexDirection: "column", backgroundColor: "#202020" }}
        >
          <text content={`Review commands\n${reviewHelp(focus, state)}\nEsc close this help`} wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {finishDialog.isOpen() ? (
        <box
          id="review-finish-dialog"
          style={{ position: "absolute", left: Math.max(1, Math.floor(dimensions.width / 8)), top: 3, width: Math.max(40, Math.floor(dimensions.width * 3 / 4)), height: 10, zIndex: 60, border: true, flexDirection: "column", backgroundColor: "#202020" }}
        >
          <text content={`Finish review — ${finishDialog.getDecision()}`} wrapMode="none" truncate={true} />
          <textarea
            id="review-finish-summary"
            ref={finishSummaryRef}
            width="100%"
            height={3}
            initialValue={finishDialog.getSummary()}
            focused={true}
            wrapMode="char"
            placeholder="Summary"
            onKeyDown={(event) => {
              const name = keyName(event)
              if (name === "escape") {
                finishDialog.close()
                session.invalidate()
                consume(event)
              } else if (event.ctrl && name.toLowerCase() === "s") {
                submitFinish()
                consume(event)
              }
            }}
            keyBindings={[{ name: "enter", action: "submit" }]}
            onSubmit={submitFinish}
            onContentChange={() => {
              finishDialog.setSummary(finishSummaryRef.current?.plainText ?? "")
              session.invalidate()
            }}
          />
          <text content={finishDialog.getValidationMessage()} wrapMode="none" truncate={true} />
          <box style={{ flexDirection: "row", height: 1 }}>
            <box id="review-finish-comment" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              finishDialog.setDecision("comment")
              session.invalidate()
            }}>
              <text content={finishDialog.getDecision() === "comment" ? "[Comment]" : " Comment "} />
            </box>
            <box id="review-finish-approve" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              finishDialog.setDecision("approve")
              session.invalidate()
            }}>
              <text content={finishDialog.getDecision() === "approve" ? "[Approve]" : " Approve "} />
            </box>
            <box id="review-finish-request-changes" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              finishDialog.setDecision("request-changes")
              session.invalidate()
            }}>
              <text content={finishDialog.getDecision() === "request-changes" ? "[Request Changes]" : " Request Changes "} />
            </box>
          </box>
          <box id="review-finish-submit" onMouseUp={() => {
            if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
            submitFinish()
          }}>
            <text content=" Submit " />
          </box>
          <text content="Ctrl-1 comment · Ctrl-2 approve · Ctrl-3 request changes · Enter/Ctrl-S submit · Esc cancel" wrapMode="none" truncate={true} />
        </box>
      ) : null}
      <box id="react-review-footer" style={{ width: "100%", height: 1, flexShrink: 0 }}>
        <text content={reviewFooter(state, layout, focus)} wrapMode="none" truncate={true} />
      </box>
    </box>
  )
}

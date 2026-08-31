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
import { createFileAnchor, createRangeAnchor } from "../../review/core/anchors"
import { coverageForFile, sortedReviewFeedback, visibleReviewFiles } from "../../review/core/selectors"
import type { HunkDiffRow } from "./hunk-diff-row-model"
import type { ReviewAnchor } from "../../review/core/types"
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
  const anchor = draft.anchor.kind === "range"
    ? `${draft.anchor.fileKey} ${draft.anchor.side}:${draft.anchor.startLine}-${draft.anchor.endLine}`
    : `${draft.anchor.fileKey} file`
  return `Feedback composer — ${draft.kind}/${draft.severity} — ${anchor}\nCtrl-S save · Esc cancel`
}
function canShowReplacementDraft(state: ReviewState): boolean {
  const draft = state.draft
  if (!draft || draft.kind !== "suggestion" || draft.anchor.kind !== "range" || draft.anchor.side !== "new") return false
  const file = state.document.files.find((candidate) => candidate.key === draft.anchor.fileKey)
  return file !== undefined && file.source !== "binary" && file.source !== "too-large"
}

function draftId(): string {
  try { return crypto.randomUUID() } catch { return Math.random().toString(36).slice(2) }
}
function keyName(key: KeyEvent): string {
  const parsed = key as unknown as { name?: string; key?: string; shift?: boolean }
  const raw = parsed.name ?? parsed.key ?? ""
  const normalized = raw === "return" ? "enter" : raw
  return parsed.shift === true && normalized.length === 1 ? normalized.toUpperCase() : normalized
}

function consume(event: KeyEvent): void {
  try { (event as unknown as { preventDefault?: () => void }).preventDefault?.() } catch {}
  try { (event as unknown as { stopPropagation?: () => void }).stopPropagation?.() } catch {}
}
type RangeStart = Readonly<{ fileKey: string; hunkIndex: number; side: "old" | "new"; startLine: number }>

function hunkRangeForSelection(file: ReviewState["document"]["files"][number], hunkIndex: number): { side: "old" | "new"; startLine: number; endLine: number } | null {
  const hunk = file.hunks[hunkIndex]
  if (!hunk) return null
  const side = hunk.newCount > 0 ? "new" : "old"
  const startLine = side === "new" ? hunk.newStart : hunk.oldStart
  const count = side === "new" ? hunk.newCount : hunk.oldCount
  return count > 0 ? { side, startLine, endLine: startLine + count - 1 } : null
}

function rangeAnchorForHunk(file: ReviewState["document"]["files"][number], hunkIndex: number): ReviewAnchor | null {
  const range = hunkRangeForSelection(file, hunkIndex)
  if (!range) return null
  try {
    return createRangeAnchor(file, range)
  } catch {
    return null
  }
}

function rowLineAddress(row: HunkDiffRow): { side: "old" | "new"; line: number } | null {
  if (row.type === "split-line") {
    if (row.right.kind !== "empty" && row.right.lineNumber !== undefined) return { side: "new", line: row.right.lineNumber }
    if (row.left.kind !== "empty" && row.left.lineNumber !== undefined) return { side: "old", line: row.left.lineNumber }
    return null
  }
  if (row.type === "stack-line") {
    if (row.cell.newLineNumber !== undefined) return { side: "new", line: row.cell.newLineNumber }
    if (row.cell.oldLineNumber !== undefined) return { side: "old", line: row.cell.oldLineNumber }
  }
  return null
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
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(null)
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null)
  const [pendingDeleteFeedbackId, setPendingDeleteFeedbackId] = useState<string | null>(null)
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
    const fileKey = current?.selection.fileKey
    const file = current && fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
    if (!current || !feedback || !file) return
    const anchor = feedback.kind === "suggestion"
      ? rangeAnchorForHunk(file, current.selection.hunkIndex)
      : feedback.anchor.kind === "range"
        ? rangeAnchorForHunk(file, current.selection.hunkIndex) ?? createFileAnchor(file)
        : createFileAnchor(file)
    if (!anchor || (feedback.kind === "suggestion" && anchor.kind !== "range")) return
    try {
      controller.dispatch(planReviewIntent(current, { type: "feedback/reanchor", id: feedbackId, anchor, updatedAt: new Date().toISOString() }))
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
      session.invalidate()
    } catch {}
  }, [controller, session])

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
      session.invalidate()
    } catch {}
  }, [controller, session])
  const selectFeedback = useCallback((feedbackId: string) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const current = controller.state
    const feedback = current?.feedback.find((entry) => entry.id === feedbackId)
    if (!current || !feedback) return
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
  const selectDiffRow = useCallback((row: HunkDiffRow) => {
    if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
    const address = rowLineAddress(row)
    const current = controller.state
    if (!address || !current) return
    const file = current.document.files.find((candidate) => candidate.key === row.fileKey)
    if (!file) return
    if (!rangeStart || rangeStart.fileKey !== row.fileKey || rangeStart.hunkIndex !== row.hunkIndex || rangeStart.side !== address.side) {
      setRangeStart({ fileKey: row.fileKey, hunkIndex: row.hunkIndex, side: address.side, startLine: address.line })
      setPendingRangeAnchor(null)
      return
    }
    try {
      setPendingRangeAnchor(createRangeAnchor(file, {
        side: address.side,
        startLine: Math.min(rangeStart.startLine, address.line),
        endLine: Math.max(rangeStart.startLine, address.line),
      }))
      setRangeStart(null)
    } catch {
      setPendingRangeAnchor(null)
    }
  }, [controller, rangeStart])
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
      } else {
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
      return true
    }
    if (commandId === "review.nextUnreviewed" || commandId === "review.prevUnreviewed") {
      const target = nextUnreviewedFile(current, commandId === "review.nextUnreviewed" ? "next" : "previous")
      if (target) {
        try { controller.dispatch(planReviewIntent(current, { type: "selection/select-file", fileKey: target })) } catch {}
      }
      return true
    }
    if (commandId === "review.nextFeedback" || commandId === "review.prevFeedback") {
      const target = feedbackTarget(current, commandId === "review.nextFeedback" ? "next" : "previous", selectedFeedbackId)
      if (target) {
        setSelectedFeedbackId(target.feedbackId)
        try { controller.dispatch(planReviewIntent(current, { type: "selection/viewport-anchor", fileKey: target.fileKey, hunkIndex: target.hunkIndex, reveal: "hunk" })) } catch {}
      }
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
      const fileKey = current.selection.fileKey
      const file = fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
      const range = file ? hunkRangeForSelection(file, current.selection.hunkIndex) : null
      if (file && range) {
        if (!rangeStart) {
          setRangeStart({ fileKey: file.key, hunkIndex: current.selection.hunkIndex, side: range.side, startLine: range.startLine })
          setPendingRangeAnchor(null)
        } else if (rangeStart.fileKey === file.key && rangeStart.hunkIndex === current.selection.hunkIndex && rangeStart.side === range.side) {
          try {
            setPendingRangeAnchor(createRangeAnchor(file, {
              side: range.side,
              startLine: Math.min(rangeStart.startLine, range.endLine),
              endLine: Math.max(rangeStart.startLine, range.endLine),
            }))
          } catch {
            setPendingRangeAnchor(null)
          }
          setRangeStart(null)
        } else {
          setRangeStart({ fileKey: file.key, hunkIndex: current.selection.hunkIndex, side: range.side, startLine: range.startLine })
          setPendingRangeAnchor(null)
        }
      }
      return true
    }
    if (commandId === "review.createFeedback") {
      if (focus !== "stream" || current.draft) return false
      const file = current.document.files.find((candidate) => candidate.key === current.selection.fileKey)
      if (file) {
        const anchor = pendingRangeAnchor && pendingRangeAnchor.fileKey === file.key
          ? pendingRangeAnchor
          : { kind: "file" as const, fileKey: file.key, contentId: file.contentId }
        try {
          controller.dispatch(planReviewIntent(current, {
            type: "feedback/start-draft",
            anchor,
            kind: "note",
            severity: "comment",
            body: "",
          }))
          setEditingFeedbackId(null)
          pendingDeleteFeedbackRef.current = null
          setPendingDeleteFeedbackId(null)
          if (anchor.kind === "range") setPendingRangeAnchor(null)
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
      finishDialog.open()
      session.invalidate()
      return true
    }
    if (commandId === "review.selectFile" && typeof payload === "object" && payload !== null && "fileKey" in payload) {
      const selection = payload as { fileKey: string; nextFocus?: "stream" | "sidebar" }
      selectFile(selection.fileKey, selection.nextFocus ?? "stream")
      return true
    }
    if (commandId === "review.selectDiffLine" && payload) {
      selectDiffRow(payload as HunkDiffRow)
      return true
    }
    if (commandId === "review.selectFeedback" && typeof payload === "string") {
      selectFeedback(payload)
      return true
    }
    return false
  }, [controller, deleteFeedback, diffWidth, editFeedback, finishDialog, focus, onClose, pendingRangeAnchor, rangeStart, reanchorFeedback, selectedFeedbackId, selectFeedback, selectDiffRow, session, sidebarWidth, toggleGap])

  const handleKey = useCallback((event: KeyEvent) => {
    if (!active) return
    const name = keyName(event)
    const current = controller.state

    // Modal input owns these keys; they must not fall through to workspace commands.
    if (name === "escape") {
      if (current?.draft) {
        try { controller.dispatch(planReviewIntent(current, { type: "feedback/cancel-draft" })) } catch {}
        setEditingFeedbackId(null)
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

    const normalized = name === "down" ? "ArrowDown" : name === "up" ? "ArrowUp" : name
    const command = resolveReviewCommand(normalized, focus)
    if (!command || (current && !command.available(current))) return
    if (executeCommand(command.id)) consume(event)
  }, [active, controller, executeCommand, finishDialog, focus, helpOpen, onClose, pendingDeleteFeedbackId, pendingRangeAnchor, rangeStart, saveDraft, session, submitFinish])
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
            onSelectFile={(fileKey) => { executeCommand("review.selectFile", { fileKey }) }}
            onSelectFeedback={(feedbackId) => { executeCommand("review.selectFeedback", feedbackId) }}
            onSelectDiffRow={(row) => { executeCommand("review.selectDiffLine", row) }}
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
              <text content={`${feedback.resolution} feedback ${feedback.id} — `} wrapMode="none" truncate={true} />
              <box id={`review-delete-feedback:${feedback.id}`} onMouseUp={() => {
                if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
                deleteFeedback(feedback.id)
              }}>
                <text content={pendingDeleteFeedbackId === feedback.id ? "[delete again]" : "[delete]"} wrapMode="none" truncate={true} />
              </box>
              </box>
          ))}
        </box>
      ) : null}
      {state.draft ? (
        <box id="review-feedback-composer" style={{ width: "100%", height: composerHeight, flexShrink: 0, border: true, flexDirection: "column" }}>
          <text content={feedbackDraftText(state)} wrapMode="none" truncate={true} />
          <box id="review-feedback-controls" style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <box id="review-feedback-kind-note" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", kind: "note" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.kind === "note" ? "[Note]" : " Note "} />
            </box>
            <box id="review-feedback-kind-suggestion" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              const latest = controller.state
              if (!latest?.draft || !suggestionAllowed) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", kind: "suggestion", replacement: "placeholder" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.kind === "suggestion" ? "[Suggestion]" : " Suggestion "} />
            </box>
            <box id="review-feedback-severity-comment" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", severity: "comment" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.severity === "comment" ? "[Comment]" : " Comment "} />
            </box>
            <box id="review-feedback-severity-blocking" onMouseUp={() => {
              if (resizingSidebarRef.current || resizeReleaseSuppressionRef.current) return
              const latest = controller.state
              if (!latest?.draft) return
              try {
                controller.dispatch(planReviewIntent(latest, { type: "feedback/update-draft", severity: "blocking" }))
                session.invalidate()
              } catch {}
            }}>
              <text content={state.draft.severity === "blocking" ? "[Blocking]" : " Blocking "} />
            </box>
          </box>
          <textarea
            id="review-feedback-body"
            ref={composerBodyRef}
            width="100%"
            height={2}
            initialValue={state.draft.body}
            focused={true}
            keyBindings={[{ name: "escape", action: "submit" }]}
            onSubmit={() => {
              const latest = controller.state
              if (latest?.draft) {
                try { controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" })) } catch {}
                setEditingFeedbackId(null)
                session.invalidate()
              }
            }}
            onKeyDown={(event) => {
              const name = keyName(event)
              const latest = controller.state
              if (name === "escape" && latest?.draft) {
                try { controller.dispatch(planReviewIntent(latest, { type: "feedback/cancel-draft" })) } catch {}
                setEditingFeedbackId(null)
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
            <textarea
              id="review-feedback-replacement"
              ref={replacementRef}
              width="100%"
              height={2}
              initialValue={state.draft.replacement ?? ""}
              focused={false}
              wrapMode="char"
              placeholder="Replacement text"
              onContentChange={() => {
                const replacement = replacementRef.current?.plainText ?? ""
                const latest = controller.state
                if (!latest?.draft || latest.draft.replacement === replacement) return
                try { controller.dispatch({ type: "feedback/update-draft", patch: { replacement } }) } catch {}
              }}
            />
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
          <text content="Ctrl-1 comment · Ctrl-2 approve · Ctrl-3 request changes · Enter/Ctrl-S submit · Esc cancel" wrapMode="none" truncate={true} />
        </box>
      ) : null}
      <box id="react-review-footer" style={{ width: "100%", height: 1, flexShrink: 0 }}>
        <text content={reviewFooter(state, layout, focus)} wrapMode="none" truncate={true} />
      </box>
    </box>
  )
}

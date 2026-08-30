import type { InputRenderable, KeyEvent, ScrollBoxRenderable, TextChunk, TextareaRenderable } from "@opentui/core"
import { StyledText, parseColor } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"
import { reviewHeaderLines } from "./header"
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
export type ReviewWorkspaceAppProps = Readonly<{
  session: ReactReviewSession
}>

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
  return `j/k:scroll | ]/[ :hunk | ./,:file | n/N:unreviewed | }:feedback | v:range | c:comment | e:edit d:delete a:reanchor | r:viewed | R:finish | 0:diff 1:files | l:layout(${layout}) | ${focus} | Esc:close — ${selected}`
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
  const [visibleFileKeys, setVisibleFileKeys] = useState<readonly string[]>([])
  const [focus, setFocus] = useState<"stream" | "sidebar" | "filter">("stream")
  const [rangeStart, setRangeStart] = useState<RangeStart | null>(null)
  const [pendingRangeAnchor, setPendingRangeAnchor] = useState<ReviewAnchor | null>(null)
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(null)
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null)
  const [pendingDeleteFeedbackId, setPendingDeleteFeedbackId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const filterInputRef = useRef<InputRenderable | null>(null)
  const pendingDeleteFeedbackRef = useRef<string | null>(null)
  const composerBodyRef = useRef<TextareaRenderable | null>(null)
  const replacementRef = useRef<TextareaRenderable | null>(null)
  const finishSummaryRef = useRef<TextareaRenderable | null>(null)
  const finishSubmitRef = useRef(false)
  const expandedSourceRef = useRef<ReadonlyMap<string, readonly string[]>>(new Map())
  const dimensions = { width: Math.max(1, terminal.width), height: Math.max(1, terminal.height) }
  const sidebarWidth = dimensions.width >= 80 ? 30 : 0
  const diffWidth = Math.max(1, dimensions.width - sidebarWidth - 2)
  const layout: "split" | "stack" = layoutMode === "auto" ? (diffWidth >= 64 ? "split" : "stack") : layoutMode
  const composerHeight = state?.draft ? (canShowReplacementDraft(state) ? 9 : 6) : 0
  const diffHeight = Math.max(1, dimensions.height - 4 - composerHeight - 2)
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

  }, [active])
  useEffect(() => {
    if (sidebarWidth === 0 && focus !== "stream") setFocus("stream")
  }, [focus, sidebarWidth])
  const toggleGap = useCallback((fileKey: string, gapId: string) => {
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

  const handleKey = useCallback((event: KeyEvent) => {
    if (!active) return
    const name = keyName(event)
    const current = controller.state

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
      onClose()
      consume(event)
      return
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
    if (focus === "filter") {
      if (name === "tab") {
        setFocus((currentFocus) => sidebarWidth === 0
          ? "stream"
          : currentFocus === "stream" ? "sidebar" : currentFocus === "sidebar" ? "filter" : "stream")
        consume(event)
        return
      }
      if (name === "enter") {
        filterInputRef.current?.blur()
        setFocus("stream")
        consume(event)
        return
      }
      return
    }
    if (name === "tab") {
      setFocus((currentFocus) => sidebarWidth === 0
        ? "stream"
        : currentFocus === "stream" ? "sidebar" : currentFocus === "sidebar" ? "filter" : "stream")
      consume(event)
      return
    }
    if (name === "/") {
      if (sidebarWidth > 0) {
        setFocus("filter")
        filterInputRef.current?.focus()
      } else {
        setFocus("stream")
      }
      consume(event)
      return
    }
    if (name === "?") {
      setHelpOpen(true)
      consume(event)
      return
    }
    if (name === "0" || name === "1") {
      setFocus(name === "1" && sidebarWidth > 0 ? "sidebar" : "stream")
      consume(event)
      return
    }
    if (name.toLowerCase() === "l") {
      setLayoutMode((currentMode) => {
        const currentLayout = currentMode === "auto" ? (diffWidth >= 64 ? "split" : "stack") : currentMode
        if (currentLayout === "split") return "stack"
        return diffWidth >= 64 ? "auto" : "split"
      })
      consume(event)
      return
    }
    if (name.toLowerCase() === "b") {
      const filterActuallyFocused = (filterInputRef.current as unknown as { focused?: boolean } | null)?.focused === true
      if (filterActuallyFocused || current?.draft || helpOpen || finishDialog.isOpen()) return
      onClose()
      consume(event)
      return
    }
    if (!current) return
    if (name === "e" && selectedFeedbackId) {
      editFeedback(selectedFeedbackId)
      consume(event)
      return
    }
    if (name === "d" && selectedFeedbackId) {
      deleteFeedback(selectedFeedbackId)
      consume(event)
      return
    }
    if (name === "a" && selectedFeedbackId) {
      reanchorFeedback(selectedFeedbackId)
      consume(event)
      return
    }
    if (name === "R") {
      finishDialog.open()
      session.invalidate()
      consume(event)
      return
    }

    if (name === "v") {
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
      consume(event)
      return
    }

    if (name === "c" && focus === "stream" && !current.draft) {
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
      consume(event)
      return
    }
    if (name.toLowerCase() === "z") {
      const fileKey = current.selection.fileKey
      const file = fileKey ? current.document.files.find((candidate) => candidate.key === fileKey) : undefined
      const hunkIndex = Math.max(1, current.selection.hunkIndex)
      if (file?.hunks[hunkIndex]) toggleGap(file.key, `before:${hunkIndex}`)
      consume(event)
      return
    }
    if (name === "n" || name === "N") {
      const target = nextUnreviewedFile(current, name === "n" ? "next" : "previous")
      if (target) {
        try { controller.dispatch(planReviewIntent(current, { type: "selection/select-file", fileKey: target })) } catch {}
      }
      consume(event)
      return
    }
    if (name === "}" || name === "{") {
      const target = feedbackTarget(current, name === "}" ? "next" : "previous", selectedFeedbackId)
      if (target) {
        setSelectedFeedbackId(target.feedbackId)
        const targetFile = current.document.files.find((file) => file.key === target.fileKey)
        if (targetFile) {
          try {
            controller.dispatch(planReviewIntent(current, { type: "selection/viewport-anchor", fileKey: target.fileKey, hunkIndex: target.hunkIndex, reveal: "hunk" }))
          } catch {}
        }
      }
      consume(event)
      return
    }
    if (name === "f") {
      const scopes = ["all", "unreviewed", "changed", "feedback"] as const
      const index = scopes.indexOf(current.filter.scope)
      const scope = scopes[(index + 1) % scopes.length] ?? "all"
      try { controller.dispatch(planReviewIntent(current, { type: "filter/set-scope", scope })) } catch {}
      consume(event)
      return
    }
    if (name === "r") {
      const fileKey = current.selection.fileKey
      if (fileKey) {
        try {
          controller.dispatch(planReviewIntent(current, { type: "viewed/mark", fileKey, viewedAt: new Date().toISOString() }))
        } catch {}
      }
      consume(event)
      return
    }

    let intent: Parameters<typeof planReviewIntent>[1] | undefined
    let navigationUnit: "file" | "hunk" | undefined
    let navigationDirection: "next" | "previous" | undefined
    if (name === "j" || name === "down" || name === "ArrowDown") {
      if (focus === "sidebar") {
        intent = { type: "selection/move", unit: "file", direction: "next" }
        navigationUnit = "file"
        navigationDirection = "next"
      } else {
        diffScrollRef.current?.scrollBy(1)
        consume(event)
      }
    } else if (name === "k" || name === "up" || name === "ArrowUp") {
      if (focus === "sidebar") {
        intent = { type: "selection/move", unit: "file", direction: "previous" }
        navigationUnit = "file"
        navigationDirection = "previous"
      } else {
        diffScrollRef.current?.scrollBy(-1)
        consume(event)
      }
    } else if (name === ".") {
      intent = { type: "selection/move", unit: "file", direction: "next" }
      navigationUnit = "file"
      navigationDirection = "next"
    } else if (name === ",") {
      intent = { type: "selection/move", unit: "file", direction: "previous" }
      navigationUnit = "file"
      navigationDirection = "previous"
    } else if (name === "]") {
      intent = { type: "selection/move", unit: "hunk", direction: "next" }
      navigationUnit = "hunk"
      navigationDirection = "next"
    } else if (name === "[") {
      intent = { type: "selection/move", unit: "hunk", direction: "previous" }
      navigationUnit = "hunk"
      navigationDirection = "previous"
    }
    if (intent) {
      try {
        const before = current.selection
        controller.dispatch(planReviewIntent(current, intent))
        const after = controller.state
        if (navigationUnit && navigationDirection && after?.selection.fileKey === before.fileKey && after.selection.hunkIndex === before.hunkIndex) {
          const fallback = fallbackSelectionIntent(current, navigationUnit, navigationDirection)
          if (fallback) controller.dispatch(planReviewIntent(current, fallback))
        }
      } catch {}
      consume(event)
    }
  }, [active, controller, deleteFeedback, diffWidth, editFeedback, finishDialog, focus, helpOpen, onClose, pendingRangeAnchor, rangeStart, reanchorFeedback, saveDraft, selectedFeedbackId, session, submitFinish, toggleGap])
  useKeyboard(handleKey)

  if (!state) {
    return (
      <box id="react-review-workspace" visible={active} style={{ width: "100%", height: "100%" }}>
        <text content="Loading branch review…" />
      </box>
    )
  }

  const selectFile = (fileKey: string, nextFocus: "stream" | "sidebar" = "stream") => {
    try {
      controller.dispatch(planReviewIntent(state, { type: "selection/select-file", fileKey }))
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
    <box id="react-review-workspace" visible={active} style={{ position: "relative", width: "100%", height: "100%", flexDirection: "column", overflow: "hidden" }}>
      <box id="react-review-header" style={{ width: "100%", height: 3, flexShrink: 0 }}>
        <text content={headerText(state, dimensions.width, controller.error)} wrapMode="none" truncate={true} />
      </box>
      <box id="react-review-body" style={{ width: "100%", flexGrow: 1, flexDirection: "row", overflow: "hidden" }}>
        {sidebarWidth > 0 ? (
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
                onMouseUp={() => setFocus("filter")}
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
                      onMouseUp={() => selectFile(entry.id, "sidebar")}
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
        ) : null}
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
            onSelectFile={selectFile}
            onSelectFeedback={selectFeedback}
            onSelectDiffRow={selectDiffRow}
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
            <box key={feedback.id} style={{ width: "100%", height: 1, flexDirection: "row" }} onMouseUp={() => setSelectedFeedbackId(feedback.id)}>
              <text content={`${feedback.resolution} feedback ${feedback.id} — `} wrapMode="none" truncate={true} />
              <box id={`review-delete-feedback:${feedback.id}`} onMouseUp={() => deleteFeedback(feedback.id)}>
                <text content={pendingDeleteFeedbackId === feedback.id ? "[delete again]" : "[delete]"} wrapMode="none" truncate={true} />
              </box>
            </box>
          ))}
        </box>
      ) : null}
      {helpOpen ? (
        <box
          id="review-help-dialog"
          style={{ position: "absolute", left: Math.max(1, Math.floor(dimensions.width / 10)), top: 2, width: Math.max(50, Math.floor(dimensions.width * 4 / 5)), height: 14, zIndex: 70, border: true, flexDirection: "column", backgroundColor: "#202020" }}
        >
          <text content={"Review commands\nj/k or arrows  scroll / move\n]/[  next / previous hunk\n./,  next / previous file\nn/N  next / previous unreviewed\n}/ {  next / previous feedback\nv  select current hunk range\nc  comment at selection\n e  edit   d  delete twice   a  reanchor\nr  mark viewed   R  finish\n0  focus diff   1  focus files   Tab  cycle focus   l  cycle layout\nEsc  close this help"} wrapMode="none" truncate={true} />
        </box>
      ) : null}
      {state.draft ? (
        <box id="review-feedback-composer" style={{ width: "100%", height: composerHeight, flexShrink: 0, border: true, flexDirection: "column" }}>
          <text content={feedbackDraftText(state)} wrapMode="none" truncate={true} />
          <box id="review-feedback-controls" style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <box id="review-feedback-kind-note" onMouseUp={() => {
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
            <box id="review-finish-comment" onMouseUp={() => { finishDialog.setDecision("comment"); session.invalidate() }}>
              <text content={finishDialog.getDecision() === "comment" ? "[Comment]" : " Comment "} />
            </box>
            <box id="review-finish-approve" onMouseUp={() => { finishDialog.setDecision("approve"); session.invalidate() }}>
              <text content={finishDialog.getDecision() === "approve" ? "[Approve]" : " Approve "} />
            </box>
            <box id="review-finish-request-changes" onMouseUp={() => { finishDialog.setDecision("request-changes"); session.invalidate() }}>
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

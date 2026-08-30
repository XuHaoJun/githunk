import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import type { ReviewState } from "../../../review/core/state"
import type { HighlightPayload } from "../../../review/git/highlight/highlight-payload"
import type { HunkReviewFile } from "../hunk-review-model"
import { ReviewDiffSection, hunkSectionRowCount, hunkSectionRowOffset } from "./ReviewDiffSection"

export type ReviewDiffPaneProps = Readonly<{
  files: readonly HunkReviewFile[]
  state: ReviewState
  layout: "split" | "stack"
  width: number
  height: number
  selectedFileKey: string | null
  selectedHunkIndex: number
  showLineNumbers?: boolean
  wrapLines?: boolean
  overscan?: number
  highlightByFileKey?: ReadonlyMap<string, HighlightPayload>
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>
  onSelectFile?: (fileKey: string) => void
  onSelectFeedback?: (feedbackId: string) => void
  onSelectDiffRow?: (row: import("../hunk-diff-row-model").HunkDiffRow) => void
  onToggleGap?: (fileKey: string, gapId: string) => void
  onVisibleFileKeysChange?: (fileKeys: readonly string[]) => void
  onViewportChange?: (top: number) => void
  selectedFeedbackId?: string | null
  selectedFileRevealToken?: number
  selectedHunkRevealToken?: number
  focused?: boolean
  scrollRef?: { current: ScrollBoxRenderable | null }
}>
type SelectionRevealRequest = Readonly<{
  fileKey: string
  hunkIndex: number
  token: number | undefined
  fileRevealToken: number | undefined
}>

type SectionWindow = Readonly<{
  heights: readonly number[]
  offsets: readonly number[]
  total: number
  first: number
  last: number
}>

function sectionWindow(
  files: readonly HunkReviewFile[],
  state: ReviewState,
  layout: "split" | "stack",
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  expandedSourceByGap: ReadonlyMap<string, readonly string[]> | undefined,
): SectionWindow {
  const heights: number[] = []
  const offsets: number[] = [0]
  let total = 0
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    const height = hunkSectionRowCount(file, layout, state, expandedSourceByGap, index > 0)
    heights.push(height)
    total += height
    offsets.push(total)
  }

  if (files.length === 0) return { heights, offsets, total, first: 0, last: -1 }
  const from = Math.max(0, Math.floor(scrollTop) - overscan)
  const to = Math.min(total, Math.floor(scrollTop) + Math.max(1, viewportHeight) + overscan)
  let first = 0
  while (first < files.length - 1 && offsets[first + 1]! <= from) first += 1
  let last = first
  while (last < files.length - 1 && offsets[last + 1]! < to) last += 1
  return { heights, offsets, total, first, last }
}

export function ReviewDiffPane({
  files,
  state,
  layout,
  width,
  height,
  selectedFileKey,
  selectedHunkIndex,
  showLineNumbers = true,
  wrapLines = false,
  overscan = Math.max(10, height * 2),
  highlightByFileKey,
  expandedSourceByGap,
  onSelectFile,
  onSelectFeedback,
  onSelectDiffRow,
  onToggleGap,
  onVisibleFileKeysChange,
  onViewportChange,
  selectedFeedbackId,
  selectedFileRevealToken,
  selectedHunkRevealToken,
  focused,
  scrollRef: externalScrollRef,
}: ReviewDiffPaneProps) {
  const ownedScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const scrollRef = externalScrollRef ?? ownedScrollRef
  const [scrollTop, setScrollTop] = useState(0)
  const previousFileRevealTokenRef = useRef(selectedFileRevealToken)
  const previousSelectionRef = useRef<{ fileKey: string | null; hunkIndex: number } | null>(null)
  const previousHunkRevealTokenRef = useRef<number | undefined>(undefined)
  const pendingSelectionRevealRequestRef = useRef<SelectionRevealRequest | null>(null)
  const pendingSelectionRevealTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const window = useMemo(
    () => sectionWindow(files, state, layout, scrollTop, height, overscan, expandedSourceByGap),
    [expandedSourceByGap, files, height, layout, overscan, scrollTop, state.expandedGaps, state.feedback],
  )
  useEffect(() => {
    if (!onVisibleFileKeysChange) return
    onVisibleFileKeysChange(files.slice(window.first, window.last + 1).map((file) => file.id))
  }, [files, onVisibleFileKeysChange, window.first, window.last])

  useEffect(() => {
    const scrollBox = scrollRef.current
    if (!scrollBox) return
    let cancelled = false
    const sync = () => {
      const nextTop = Math.max(0, Math.floor(scrollBox.scrollTop))
      if (!cancelled) {
        setScrollTop(nextTop)
        onViewportChange?.(nextTop)
      }
    }
    scrollBox.verticalScrollBar.on("change", sync)
    scrollBox.viewport.on("layout-changed", sync)
    scrollBox.viewport.on("resized", sync)
    sync()
    return () => {
      cancelled = true
      scrollBox.verticalScrollBar.off("change", sync)
      scrollBox.viewport.off("layout-changed", sync)
      scrollBox.viewport.off("resized", sync)
    }
  }, [files.length])
  useLayoutEffect(() => {
    if (selectedFileRevealToken === undefined || previousFileRevealTokenRef.current === selectedFileRevealToken || !selectedFileKey) return

    const index = files.findIndex((file) => file.id === selectedFileKey)
    if (index < 0) return

    previousFileRevealTokenRef.current = selectedFileRevealToken
    if (state.reveal.scrollToFeedback) return

    const sectionTop = window.offsets[index] ?? 0
    const target = Math.min(Math.max(0, sectionTop), Math.max(0, window.total - height))
    const scrollBox = scrollRef.current
    if (scrollBox) scrollBox.scrollTop = target
    setScrollTop(target)
    onViewportChange?.(target)
  }, [files, height, onViewportChange, scrollRef, selectedFileKey, selectedFileRevealToken, state.reveal.scrollToFeedback, window])

  // Keep file-top and hunk reveals as ordered requests: a batched cross-file move can
  // change both, and the later hunk request must win.
  useLayoutEffect(() => {
    const currentSelection = { fileKey: selectedFileKey, hunkIndex: selectedHunkIndex }
    const previousSelection = previousSelectionRef.current
    const selectionChanged = previousSelection === null
      || previousSelection.fileKey !== selectedFileKey
      || previousSelection.hunkIndex !== selectedHunkIndex
    const previousHunkRevealToken = previousHunkRevealTokenRef.current
    const hunkRevealRequested = selectedHunkRevealToken !== undefined
      && previousHunkRevealToken !== selectedHunkRevealToken
    const pendingRequest = pendingSelectionRevealRequestRef.current
    const pendingRequestMatches = pendingRequest !== null
      && pendingRequest.fileKey === selectedFileKey
      && pendingRequest.hunkIndex === selectedHunkIndex
      && pendingRequest.token === selectedHunkRevealToken
      && pendingRequest.fileRevealToken === selectedFileRevealToken
    const shouldReveal = selectedHunkRevealToken === undefined
      ? selectionChanged || pendingRequestMatches
      : hunkRevealRequested
        || (state.reveal.scrollToFeedback && selectionChanged)
        || pendingRequestMatches
    const clearPendingTimers = () => {
      for (const timer of pendingSelectionRevealTimersRef.current) clearTimeout(timer)
      pendingSelectionRevealTimersRef.current = []
    }

    if (!selectedFileKey) {
      clearPendingTimers()
      if (!shouldReveal) {
        pendingSelectionRevealRequestRef.current = null
        previousSelectionRef.current = currentSelection
        previousHunkRevealTokenRef.current = selectedHunkRevealToken
      }
      return
    }

    if (!shouldReveal) {
      clearPendingTimers()
      pendingSelectionRevealRequestRef.current = null
      previousSelectionRef.current = currentSelection
      previousHunkRevealTokenRef.current = selectedHunkRevealToken
      return
    }

    const index = files.findIndex((file) => file.id === selectedFileKey)
    const selectedFile = index < 0 ? undefined : files[index]
    // Filtered files may reappear after this effect; retain the request so it is not lost.
    if (!selectedFile) {
      pendingSelectionRevealRequestRef.current = {
        fileKey: selectedFileKey,
        hunkIndex: selectedHunkIndex,
        token: selectedHunkRevealToken,
        fileRevealToken: selectedFileRevealToken,
      }
      return
    }

    previousSelectionRef.current = currentSelection
    previousHunkRevealTokenRef.current = selectedHunkRevealToken
    const request: SelectionRevealRequest = {
      fileKey: selectedFileKey,
      hunkIndex: selectedHunkIndex,
      token: selectedHunkRevealToken,
      fileRevealToken: selectedFileRevealToken,
    }
    pendingSelectionRevealRequestRef.current = request
    clearPendingTimers()

    const sectionTop = window.offsets[index] ?? 0
    const sectionHeight = window.heights[index] ?? 0
    const hunkOffset = hunkSectionRowOffset(selectedFile, layout, Math.max(0, selectedHunkIndex), state, expandedSourceByGap, index > 0)
    const target = sectionTop + Math.min(Math.max(0, hunkOffset), Math.max(0, sectionHeight - 1))

    const revealSelection = () => {
      const scrollBox = scrollRef.current
      if (!scrollBox) return
      const viewportHeight = Math.max(1, Math.floor(scrollBox.viewport.height || height))
      const currentTop = Math.max(0, Math.floor(scrollBox.scrollTop))
      const currentEnd = currentTop + viewportHeight
      if (target < currentTop || target + 1 > currentEnd) {
        const nextTop = Math.min(Math.max(0, target), Math.max(0, window.total - viewportHeight))
        scrollBox.scrollTop = nextTop
        setScrollTop(nextTop)
        onViewportChange?.(nextTop)
      }
    }

    revealSelection()
    const retryDelays = [0, 16, 48]
    pendingSelectionRevealTimersRef.current = retryDelays.map((delay, retryIndex) => setTimeout(() => {
      const currentRequest = pendingSelectionRevealRequestRef.current
      if (
        currentRequest === null
        || currentRequest.fileKey !== request.fileKey
        || currentRequest.hunkIndex !== request.hunkIndex
        || currentRequest.token !== request.token
        || currentRequest.fileRevealToken !== request.fileRevealToken
      ) return
      revealSelection()
      if (retryIndex === retryDelays.length - 1) {
        pendingSelectionRevealRequestRef.current = null
        pendingSelectionRevealTimersRef.current = []
      }
    }, delay))
    return clearPendingTimers
  }, [expandedSourceByGap, files, height, layout, onViewportChange, selectedFileKey, selectedFileRevealToken, selectedHunkIndex, selectedHunkRevealToken, state])

  const leadingSpacer = window.offsets[window.first] ?? 0
  const trailingSpacer = window.total - (window.offsets[window.last + 1] ?? window.total)

  return (
    <scrollbox
      id="review-diff-scrollbox"
      ref={scrollRef}
      {...(focused === undefined ? {} : { focused })}
      width="100%"
      height="100%"
      scrollY={true}
      viewportCulling={true}
      verticalScrollbarOptions={{ visible: false }}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction
        const delta = Math.max(1, Math.floor(event.scroll?.delta ?? 1))
        const target = event.currentTarget as ScrollBoxRenderable | null
        const scrollBox = target && typeof target.scrollBy === "function" ? target : scrollRef.current
        if (direction === "down") scrollBox?.scrollBy(delta)
        else if (direction === "up") scrollBox?.scrollBy(-delta)
      }}
    >
      <box id="review-diff-content" style={{ width: "100%", flexDirection: "column" }}>
        {leadingSpacer > 0 ? <box key="review-leading-spacer" style={{ width: "100%", height: leadingSpacer }} /> : null}
        {window.first <= window.last
          ? files.slice(window.first, window.last + 1).map((file, offset) => {
              const fileIndex = window.first + offset
              const sectionTop = window.offsets[fileIndex] ?? 0
              const sectionHeight = window.heights[fileIndex] ?? 0
              const rowStart = Math.max(0, Math.floor(scrollTop - sectionTop - overscan))
              const rowEnd = Math.min(sectionHeight, Math.ceil(scrollTop + Math.max(1, height) + overscan - sectionTop))
              const highlight = highlightByFileKey?.get(file.id)
              const select = onSelectFile ? () => onSelectFile(file.id) : undefined
              return (
                <ReviewDiffSection
                  key={file.id}
                  file={file}
                  state={state}
                  layout={layout}
                  width={width}
                  selectedHunkIndex={file.id === selectedFileKey ? selectedHunkIndex : -1}
                  showDivider={fileIndex > 0}
                  showLineNumbers={showLineNumbers}
                  wrapLines={wrapLines}
                  rowStart={rowStart}
                  rowEnd={Math.max(rowStart, rowEnd)}
                  {...(highlight ? { highlight } : {})}
                  {...(expandedSourceByGap ? { expandedSourceByGap } : {})}
                  {...(select ? { onSelect: select } : {})}
                  {...(onSelectFeedback ? { onSelectFeedback } : {})}
                  {...(onSelectDiffRow ? { onSelectDiffRow } : {})}
                  {...(selectedFeedbackId !== undefined ? { selectedFeedbackId } : {})}
                  {...(onToggleGap ? { onToggleGap: (gapId: string) => onToggleGap(file.id, gapId) } : {})}
                />
              )
            })
          : null}
        {trailingSpacer > 0 ? <box key="review-trailing-spacer" style={{ width: "100%", height: trailingSpacer }} /> : null}
      </box>
    </scrollbox>
  )
}

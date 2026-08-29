import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent, type MouseEvent } from "@opentui/core"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"
import { computeReviewLayout } from "./layout"
import type { ReviewLayoutMode } from "./layout"
import { reviewHeaderLines } from "./header"
import { buildReviewSidebarEntries, getFileStateIcon, sidebarEntryStats } from "./review-sidebar"
import { REVIEW_COMMANDS, resolveReviewCommand, reviewHints } from "./command-catalog"
import type { ReviewFocus } from "./command-catalog"
import { planReviewIntent } from "../../review/core/intents"
import { coverageForFile, visibleReviewFiles, sortedReviewFeedback } from "../../review/core/selectors"
import { ReviewStreamPane } from "./stream-pane"
import { planReviewRows, reviewFileStartOffset } from "./row-planner"
import { installReviewStreamHighlights, releaseReviewStreamHighlights } from "./review-highlight-text"
import { FeedbackComposer } from "./feedback-composer"
import { FeedbackPane } from "./feedback-pane"
import { FinishDialog } from "./finish-dialog"
import type { ReviewAnchor } from "../../review/core/types"
import { createRangeAnchor } from "../../review/core/anchors"
import type { ClipboardPort } from "../clipboard"
import type { ReviewWorkspaceError } from "./error-state"
import { isEmptyReview, isDetachedSnapshot } from "./error-state"
import { cellWidth } from "../cell-width"

export type ReviewWorkspaceOptions = {
  readonly onClose?: () => void
  readonly clipboard?: ClipboardPort
}

type Focus = ReviewFocus

export class ReviewWorkspace {
  readonly root: BoxRenderable
  private readonly headerBox: BoxRenderable
  private readonly sidebarBox: BoxRenderable
  private readonly sidebarText: TextRenderable
  private readonly streamBox: BoxRenderable
  private readonly footerBox: BoxRenderable
  private readonly headerText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly streamText: TextRenderable
  private readonly streamPane: ReviewStreamPane
  private readonly feedbackComposer: FeedbackComposer
  private readonly feedbackPane: FeedbackPane
  private readonly finishDialog: FinishDialog
  private pendingRangeAnchor: ReviewAnchor | null = null
  private destroyed = false
  private unsubscribe: (() => void) | undefined
  private readonly handleKey: (key: KeyEvent) => void
  private focus: Focus = "stream"
  private rangeActive = false
  private layoutMode: ReviewLayoutMode = "auto"
  private sidebarVisible = true
  private viewportStart = 0
  private sidebarViewportStart = 0
  private lastFileTopToken = -1
  private lastState: ReviewState | undefined
  private mouseError: string | null = null
  private overriddenWidth: number | undefined
  private overriddenHeight: number | undefined

  getError(): ReviewWorkspaceError | undefined {
    return this.controller.error
  }

  dismissError(): boolean {
    if (!this.controller.error) return false
    this.controller.clearError()
    this.render(this.controller.state)
    return true
  }

  async retryError(): Promise<boolean> {
    const err = this.controller.error
    if (!err) return false
    if (err.action !== "retry") return false
    await this.controller.refreshGeneration()
    this.render(this.controller.state)
    return true
  }

  getWorkspaceStatus(): "empty" | "detached" | "normal" | "error" {
    const err = this.controller.error
    if (err) return "error"
    const state = this.controller.state
    if (!state) return "normal"
    if (isEmptyReview(state.document)) return "empty"
    if (isDetachedSnapshot(state.document)) return "detached"
    return "normal"
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly controller: ReviewWorkspaceController,
    private readonly options: ReviewWorkspaceOptions = {},
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "review-workspace",
      border: true,
      title: "Branch Review",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      overflow: "hidden",
    })
    renderer.root.add(this.root)

    // Header
    this.headerBox = new BoxRenderable(renderer, {
      id: "review-header",
      flexDirection: "column",
      height: 3,
      width: "100%",
      overflow: "hidden",
    })
    this.headerText = new TextRenderable(renderer, {
      id: "review-header-text",
      content: "",
      wrapMode: "none",
      width: "100%",
      height: "100%",
    })
    this.headerBox.add(this.headerText)

    // Body row: sidebar + stream
    const body = new BoxRenderable(renderer, {
      id: "review-body",
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
      overflow: "hidden",
    })
    this.sidebarBox = new BoxRenderable(renderer, {
      id: "review-sidebar",
      width: 28,
      height: "100%",
      border: true,
      title: "Files",
      overflow: "hidden",
    })
    this.sidebarText = new TextRenderable(renderer, {
      id: "review-sidebar-text",
      content: "",
      wrapMode: "none",
      width: "100%",
      height: "100%",
    })
    this.sidebarBox.add(this.sidebarText)
    this.sidebarBox.onMouseDown = (event: MouseEvent) => {
      const row = Math.floor(event.y - this.sidebarBox.y - 1)
      if (this.handleSidebarRowClick(row)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    this.streamBox = new BoxRenderable(renderer, {
      id: "review-stream",
      flexGrow: 1,
      height: "100%",
      border: true,
      title: "Diff",
      overflow: "hidden",
    })
    this.streamText = new TextRenderable(renderer, {
      id: "review-stream-text",
      content: "",
      wrapMode: "none",
      width: "100%",
      height: "100%",
    })
    this.streamBox.add(this.streamText)
    body.add(this.sidebarBox)
    body.add(this.streamBox)
    this.root.onMouse = (event: MouseEvent) => {
      const type = (event as unknown as { type?: string }).type
      if (type === "scroll") {
        const delta = reviewMouseWheelDelta(event)
        if (delta === 0) return
        const hitStream = event.x >= this.streamBox.x
          && event.x < this.streamBox.x + this.streamBox.width
          && event.y >= this.streamBox.y
          && event.y < this.streamBox.y + this.streamBox.height
        const hitSidebar = event.x >= this.sidebarBox.x
          && event.x < this.sidebarBox.x + this.sidebarBox.width
          && event.y >= this.sidebarBox.y
          && event.y < this.sidebarBox.y + this.sidebarBox.height
        if (hitStream) {
          this.scrollStreamBy(delta)
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (hitSidebar) {
          const sidebarHeight = Math.max(1, this.sidebarBox.height - 2)
          const stateForWheel = this.controller.state
          const rawContent = this.sidebarText.content as unknown as string
          const fileRowCount = stateForWheel ? buildReviewSidebarEntries(stateForWheel).length : String(rawContent).split("\n").length
          const maxStart = Math.max(0, fileRowCount - sidebarHeight)
          this.sidebarViewportStart = Math.max(0, Math.min(maxStart, this.sidebarViewportStart + delta))
          this.render(this.controller.state)
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }
    }

    // Footer hints
    this.footerBox = new BoxRenderable(renderer, {
      id: "review-footer",
      height: 1,
      width: "100%",
      flexDirection: "row",
      overflow: "hidden",
    })
    this.footerText = new TextRenderable(renderer, {
      id: "review-footer-text",
      content: "",
      wrapMode: "none",
      width: "100%",
      height: "100%",
    })
    this.footerBox.add(this.footerText)

    this.root.add(this.headerBox)
    this.root.add(body)
    this.root.add(this.footerBox)

    // Stream pane — viewport windowed diff stream
    const getLayout = () => {
      const w = (this.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? 80
      const h = (this.renderer as unknown as { terminalHeight?: number }).terminalHeight ?? 24
      return computeReviewLayout(w, h, this.layoutMode, this.sidebarVisible)
    }
    this.streamPane = new ReviewStreamPane({
      controller: this.controller,
      getLayout,
      getState: () => this.controller.state,
      viewportHeight: getLayout().stream.height,
      width: getLayout().stream.width,
      effectiveMode: getLayout().effectiveMode,
      showLineNumbers: true,
      wrapLines: false,
    })

    const clipboardPort: ClipboardPort = options.clipboard ?? {
      isOsc52Supported: () => false,
      copyToClipboardOSC52: () => false,
    }
    this.feedbackComposer = new FeedbackComposer({ controller: this.controller })
    this.feedbackPane = new FeedbackPane({ controller: this.controller })
    this.finishDialog = new FinishDialog({ controller: this.controller, clipboard: clipboardPort })

    this.unsubscribe = this.controller.subscribe((state) => {
      if (this.destroyed) return
      this.render(state)
    })
    this.render(this.controller.state)

    this.handleKey = (key: KeyEvent) => {
      const raw = (key as unknown as { name?: string }).name ?? (key as unknown as { key?: string }).key ?? ""
      const name = raw === "return" ? "enter" : raw
      const ctrl = (key as unknown as { ctrl?: boolean }).ctrl ?? false
      if (ctrl && (name === "s" || name === "S")) {
        const handled = this.handleKeyPress("ctrl+s")
        if (handled) {
          key.preventDefault?.()
          key.stopPropagation?.()
        }
        return
      }
      const handled = this.handleKeyPress(name)
      if (handled) {
        key.preventDefault?.()
        key.stopPropagation?.()
      }
    }
    renderer.keyInput.on("keypress", this.handleKey)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Flush drafts on destroy (orderly exit)
    try {
      void this.controller.flushDrafts?.()
    } catch {}
    try {
      this.unsubscribe?.()
    } catch {}
    try {
      this.renderer.keyInput.off("keypress", this.handleKey)
    } catch {}
    try {
      this.sidebarBox.onMouseDown = undefined
    } catch {}
    try {
      this.root.onMouse = undefined
    } catch {}
    try {
      releaseReviewStreamHighlights(this.streamText)
    } catch {}
    try {
      releaseReviewStreamHighlights(this.streamText)
    } catch {}
    try {
      this.root.destroyRecursively()
    } catch {}
  }

  // Public for tests / mouse routing
  handleSidebarClick(fileKey: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const exists = state.document.files.some((f) => f.key === fileKey)
    if (!exists) return false
    try {
      const action = planReviewIntent(state, { type: "selection/select-file", fileKey })
      this.controller.dispatch(action)
      this.focus = "stream"
      this.renderer.requestRender?.()
      return true
    } catch {
      return false
    }
  }

  handleSidebarRowClick(visibleRow: number): boolean {
    if (!Number.isInteger(visibleRow) || visibleRow < 0) return false
    const state = this.controller.state
    if (!state) return false
    const entries = buildReviewSidebarEntries(state)
    const entry = entries[this.sidebarViewportStart + visibleRow]
    if (!entry || entry.kind !== "file") return false
    return this.handleSidebarClick(entry.id)
  }
  // Alias for test compatibility
  clickFile(fileKey: string): boolean {
    return this.handleSidebarClick(fileKey)
  }

  getFocus(): Focus {
    return this.focus
  }

  setRangeActive(active: boolean): void {
    this.rangeActive = active
  }

  isRangeActive(): boolean {
    return this.rangeActive
  }

  getFeedbackComposer(): FeedbackComposer {
    return this.feedbackComposer
  }

  getFeedbackPane(): FeedbackPane {
    return this.feedbackPane
  }

  getFinishDialog(): FinishDialog {
    return this.finishDialog
  }

  getPendingRangeAnchor(): ReviewAnchor | null {
    return this.pendingRangeAnchor
  }

  clearPendingRangeAnchor(): void {
    this.pendingRangeAnchor = null
  }

  // Main keyboard entry — returns true if handled
  handleKeyPress(keyName: string): boolean {
    const normalized = keyName === "return" ? "enter" : keyName
    const state = this.controller.state

    // Composer focus handling: tab stays inside composer until close, Ctrl+S and Escape handled by composer
    if (this.feedbackComposer.isOpen()) {
      if (normalized === "tab" || normalized === "shift+tab" || normalized === "s-tab") {
        this.feedbackComposer.handleKey(normalized)
        this.render(state)
        return true
      }
      if (normalized === "ctrl+s" || normalized === "ctrl-s") {
        this.feedbackComposer.handleKey(normalized)
        // After save, focus returns to stream
        if (!this.feedbackComposer.isOpen()) {
          this.focus = "stream"
          this.pendingRangeAnchor = null
        }
        this.render(this.controller.state)
        return true
      }
      if (normalized === "escape") {
        // Let composer handle cancel
        this.feedbackComposer.cancel()
        this.focus = "stream"
        this.render(this.controller.state)
        return true
      }
      // While composer is open, other keys are considered handled to keep focus inside (tab containment)
      const cmdWhileComposer = resolveReviewCommand(normalized, this.focus)
      if (cmdWhileComposer) return true
      const anyCmdWhileComposer = resolveReviewCommand(normalized, "any")
      if (anyCmdWhileComposer) return true
      return true
    }

    // Escape priority: draft > range > filter > workspace
    if (normalized === "escape") {
      if (state?.draft) {
        try {
          this.feedbackComposer.cancel()
        } catch {
          try {
            const action = planReviewIntent(state, { type: "feedback/cancel-draft" })
            this.controller.dispatch(action)
          } catch {}
        }
        this.focus = "stream"
        this.render(this.controller.state)
        return true
      }
      if (this.rangeActive || this.streamPane.isRangeActive()) {
        this.rangeActive = false
        this.pendingRangeAnchor = null
        try { this.streamPane.endRangeSelection() } catch {}
        this.renderer.requestRender?.()
        return true
      }
      if (this.focus === "filter") {
        this.focus = "stream"
        this.renderer.requestRender?.()
        return true
      }
      if (this.finishDialog.isOpen()) {
        this.finishDialog.close()
        this.render(state)
        return true
      }
      this.options.onClose?.()
      return true
    }

    // Finish dialog: trap keys when open
    if (this.finishDialog.isOpen()) {
      if (normalized === "enter" || normalized === "ctrl+s") {
        void this.finishDialog.submit().then(() => this.render(this.controller.state))
        return true
      }
      // tab inside dialog stays, escape handled above
      return true
    }

    // Gap expansion via z
    if (normalized === "z" || normalized === "Z") {
      if (state) {
        const plan = this.streamPane.getLastPlan()
        if (plan) {
          for (let i = 0; i < plan.rows.length; i++) {
            const row = plan.rows[i]!
            if (row.kind === "gap") {
              const globalRow = plan.start + i
              void this.streamPane.expandGapAtViewportRow(globalRow)
              this.render(state)
              return true
            }
          }
        }
        const fileKey = state.selection.fileKey
        if (fileKey) {
          const file = state.document.files.find(f => f.key === fileKey)
          if (file && file.hunks.length > 1) {
            const gapId = `before:1`
            void this.controller.expandGap(fileKey, gapId)
            this.render(state)
            return true
          }
        }
      }
      return true
    }

    // Filter focus trigger
    if (normalized === "/") {
      this.focus = "filter"
      this.renderer.requestRender?.()
      return true
    }

    if (normalized === "tab") {
      if (this.focus === "stream") this.focus = "sidebar"
      else if (this.focus === "sidebar") this.focus = "filter"
      else this.focus = "stream"
      this.render(state)
      return true
    }

    // Layout mode switches — always available
    if (normalized === "0" || normalized === "1" || normalized === "2") {
      this.layoutMode = normalized === "0" ? "auto" : normalized === "1" ? "split" : "stack"
      const w = (this.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? 80
      const h = (this.renderer as unknown as { terminalHeight?: number }).terminalHeight ?? 24
      const newEffective = this.layoutMode === "auto" ? computeReviewLayout(w, h, this.layoutMode, this.sidebarVisible).effectiveMode : this.layoutMode as "split" | "stack"
      this.streamPane.handleModeChange(newEffective)
      this.render(state)
      return true
    }

    // Resolve through the active focus. Commands declared for "any" remain available
    // through commandSupportsFocus; no focus-bypassing fallback is allowed.
    const cmd = resolveReviewCommand(normalized, this.focus)
    if (!cmd) return false
    if (state && !cmd.available(state)) return false

    switch (cmd.id) {
      case "review.moveDown":
      case "review.moveUp": {
        if (!state) return false
        const direction = cmd.id === "review.moveDown" ? "next" : "previous"
        if (this.focus === "sidebar") {
          try {
            const action = planReviewIntent(state, { type: "selection/move", unit: "file", direction })
            this.controller.dispatch(action)
          } catch {}
        } else {
          this.streamPane.scrollBy(direction === "next" ? 1 : -1)
          this.viewportStart = this.streamPane.getViewportStart()
        }
        this.render(this.controller.state)
        return true
      }
      case "review.nextHunk": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "hunk", direction: "next" })
          this.controller.dispatch(action)
        } catch {}
        this.render(this.controller.state)
        return true
      }
      case "review.prevHunk": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "hunk", direction: "previous" })
          this.controller.dispatch(action)
        } catch {}
        this.render(this.controller.state)
        return true
      }
      case "review.nextFile": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "file", direction: "next" })
          this.controller.dispatch(action)
        } catch {}
        this.render(this.controller.state)
        return true
      }
      case "review.prevFile": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "file", direction: "previous" })
          this.controller.dispatch(action)
        } catch {}
        this.render(this.controller.state)
        return true
      }
      case "review.nextUnreviewed": {
        if (!state) return false
        const target = findNextUnreviewed(state, "next")
        if (target) {
          try {
            const action = planReviewIntent(state, { type: "selection/select-file", fileKey: target })
            this.controller.dispatch(action)
          } catch {}
        }
        this.render(this.controller.state)
        return true
      }
      case "review.prevUnreviewed": {
        if (!state) return false
        const target = findNextUnreviewed(state, "previous")
        if (target) {
          try {
            const action = planReviewIntent(state, { type: "selection/select-file", fileKey: target })
            this.controller.dispatch(action)
          } catch {}
        }
        this.render(this.controller.state)
        return true
      }
      case "review.nextFeedback": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "feedback/next" })
          this.controller.dispatch(action)
        } catch {}
        // Also update feedback pane navigation but reducer handles
        this.render(this.controller.state)
        return true
      }
      case "review.prevFeedback": {
        if (!state) return false
        try {
          const action = planReviewIntent(state, { type: "feedback/previous" })
          this.controller.dispatch(action)
        } catch {}
        this.render(this.controller.state)
        return true
      }
      case "review.focusFilter": {
        this.focus = "filter"
        this.renderer.requestRender?.()
        return true
      }
      case "review.toggleFocus": {
        return true
      }
      case "review.toggleRange": {
        const wasActive = this.rangeActive || this.streamPane.isRangeActive()
        if (!wasActive) {
          const plan = this.streamPane.getLastPlan()
          if (plan) {
            let startRow: number | null = null
            for (let i = 0; i < plan.rows.length; i++) {
              const r = plan.rows[i]!
              if (r.kind === "diff" && (r.oldLine !== null || r.newLine !== null)) {
                startRow = plan.start + i
                break
              }
            }
            if (startRow !== null) this.streamPane.beginRangeAtViewportRow(startRow)
          }
          this.rangeActive = true
        } else {
          const plan = this.streamPane.getLastPlan()
          let endRow: number | null = null
          if (plan) {
            for (let i = plan.rows.length - 1; i >= 0; i--) {
              const r = plan.rows[i]!
              if (r.kind === "diff" && (r.oldLine !== null || r.newLine !== null)) { endRow = plan.start + i; break }
            }
          }
          if (endRow !== null && plan) {
            this.streamPane.updateRangeEnd(endRow)
            const result = this.streamPane.endRangeSelection()
            if (result.ok && state) {
              const file = state.document.files.find(f => f.key === result.anchor.fileKey)
              if (file) {
                try {
                  const anchor = createRangeAnchor(file, { side: result.anchor.side, startLine: result.anchor.startLine, endLine: result.anchor.endLine })
                  this.pendingRangeAnchor = anchor
                } catch {
                  // fallback with placeholder anchor if createRangeAnchor fails due to binary etc
                  const anchor: ReviewAnchor = {
                    kind: "range",
                    fileKey: result.anchor.fileKey,
                    contentId: file.contentId,
                    side: result.anchor.side,
                    startLine: result.anchor.startLine,
                    endLine: result.anchor.endLine,
                    ownerHunkIndex: result.anchor.ownerHunkIndex,
                    contextDigest: "digest-placeholder",
                  }
                  this.pendingRangeAnchor = anchor
                }
              }
            }
          }
          this.rangeActive = false
        }
        this.renderer.requestRender?.()
        return true
      }
      case "review.createFeedback": {
        if (!state) return false
        if (this.feedbackComposer.isOpen()) return true
        const fileKey = state.selection.fileKey
        if (!fileKey) return true
        const file = state.document.files.find((f) => f.key === fileKey)
        if (!file) return true
        // Use pending range anchor if available and matches current file, otherwise file anchor
        let anchorToUse: ReviewAnchor | null = null
        if (this.pendingRangeAnchor && this.pendingRangeAnchor.fileKey === fileKey && this.pendingRangeAnchor.contentId === file.contentId) {
          anchorToUse = this.pendingRangeAnchor
        } else {
          anchorToUse = { kind: "file" as const, fileKey, contentId: file.contentId }
        }
        // Delegate to composer which handles binary restriction and validation
        const opened = this.feedbackComposer.open(anchorToUse, "note", "comment", "")
        if (opened) {
          this.focus = "composer" as Focus
          // Clear pending range after consumption
          if (anchorToUse.kind === "range") this.pendingRangeAnchor = null
        }
        this.render(this.controller.state)
        return true
      }
      case "review.markViewed": {
        if (!state) return false
        const fileKey = state.selection.fileKey
        if (!fileKey) return true
        try {
          const action = planReviewIntent(state, { type: "viewed/mark", fileKey, viewedAt: new Date().toISOString() })
          this.controller.dispatch(action)
        } catch {}
        return true
      }
      case "review.layoutAuto":
      case "review.layoutSplit":
      case "review.layoutStack": {
        const m = cmd.id === "review.layoutAuto" ? "auto" : cmd.id === "review.layoutSplit" ? "split" : "stack"
        this.layoutMode = m as ReviewLayoutMode
        const w = (this.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? 80
        const h = (this.renderer as unknown as { terminalHeight?: number }).terminalHeight ?? 24
        const newEffective = m === "auto" ? computeReviewLayout(w, h, this.layoutMode, this.sidebarVisible).effectiveMode : m as "split" | "stack"
        this.streamPane.handleModeChange(newEffective)
        this.render(state)
        return true
      }
      case "review.finishReview": {
        // Open finish dialog via FinishDialog
        this.finishDialog.open()
        this.focus = "stream"
        this.render(state)
        return true
      }
      case "review.help":
      case "review.close": {
        if (cmd.id === "review.close") {
          this.options.onClose?.()
        }
        return true
      }
      default:
        return false
    }
  }

  // Compatibility aliases
  dispatchKey(key: string): boolean {
    return this.handleKeyPress(key)
  }

  onKey(key: unknown): boolean {
    const name = (key as { name?: string }).name ?? (key as { key?: string }).key ?? String(key)
    return this.handleKeyPress(name)
  }

  // Mouse / scroll / gap / range helpers for tests
  getStreamPane(): ReviewStreamPane {
    return this.streamPane
  }

  scrollStreamBy(delta: number): void {
    this.streamPane.scrollBy(delta)
    this.viewportStart = this.streamPane.getViewportStart()
    this.render(this.controller.state)
  }

  handleStreamMouseDrag(startRow: number, endRow: number): { ok: boolean; reason?: string } {
    // If feedback pane is reanchoring, treat drag as re-anchor range selection
    if (this.feedbackPane.isReanchoring()) {
      const result = this.streamPane.handleMouseDrag(startRow, endRow)
      if (result.ok) {
        // result.anchor holds range; dispatch reanchor via pane
        const reanchorId = this.feedbackPane.getReanchorId()
        if (reanchorId) {
          const state = this.controller.state
          if (state) {
            const file = state.document.files.find(f => f.key === result.anchor.fileKey)
            if (file) {
              try {
                const newAnchor = createRangeAnchor(file, { side: result.anchor.side, startLine: result.anchor.startLine, endLine: result.anchor.endLine })
                this.feedbackPane.confirmReanchor(reanchorId, newAnchor)
              } catch {
                const fallback: ReviewAnchor = {
                  kind: "range",
                  fileKey: result.anchor.fileKey,
                  contentId: file.contentId,
                  side: result.anchor.side,
                  startLine: result.anchor.startLine,
                  endLine: result.anchor.endLine,
                  ownerHunkIndex: result.anchor.ownerHunkIndex,
                  contextDigest: "digest-placeholder",
                }
                this.feedbackPane.confirmReanchor(reanchorId, fallback)
              }
            }
          }
        }
        this.mouseError = null
        this.render(this.controller.state)
        return { ok: true }
      } else {
        this.mouseError = result.reason ?? null
        this.render(this.controller.state)
        return result as { ok: boolean; reason?: string }
      }
    }
    const result = this.streamPane.handleMouseDrag(startRow, endRow)
    if (!result.ok) this.mouseError = result.reason ?? null
    else {
      this.mouseError = null
      // On successful drag that yields a range, store as pending for next 'c' (keyboard/mouse parity)
      if (result.ok && (result as unknown as { anchor?: ReviewAnchor }).anchor) {
        const anchor = (result as unknown as { anchor: ReviewAnchor }).anchor
        this.pendingRangeAnchor = anchor
      } else if (result.ok) {
        // streamPane.handleMouseDrag may return {ok:true, anchor:...} — check via endRangeSelection?
        // For parity, also try to get last range
        try {
          const last = this.streamPane.getLastPlan()
          void last
        } catch {}
      }
    }
    this.render(this.controller.state)
    return result as { ok: boolean; reason?: string }
  }

  getMouseError(): string | null {
    return this.mouseError ?? this.streamPane.getLastMouseError()
  }

  handleGapClickAtRow(viewportRow: number): Promise<{ ok: boolean; reason?: string }> {
    return this.streamPane.expandGapAtViewportRow(viewportRow)
  }

  async expandGap(fileKey: string, gapId: string): Promise<void> {
    await this.controller.expandGap(fileKey, gapId)
    this.render(this.controller.state)
  }

  // Feedback pane mouse helpers for parity
  handleFeedbackClick(id: string): boolean {
    return this.feedbackPane.selectFeedback(id)
  }

  handleFeedbackReanchorClick(id: string): boolean {
    return this.feedbackPane.beginReanchor(id)
  }

  handleFeedbackDeleteClick(id: string): { needsConfirm: boolean; canDelete: boolean } {
    return this.feedbackPane.requestDelete(id)
  }

  handleFeedbackDeleteConfirm(id: string): boolean {
    return this.feedbackPane.confirmDelete(id)
  }

  handleComposerSave(): boolean {
    return this.feedbackComposer.clickSave()
  }

  handleComposerCancel(): boolean {
    return this.feedbackComposer.clickCancel()
  }

  handleResize(width: number, height: number): void {
    this.overriddenWidth = width
    this.overriddenHeight = height
    const layout = computeReviewLayout(width, height, this.layoutMode, this.sidebarVisible)
    this.streamPane.handleResize(layout.stream.width, layout.stream.height)
    this.render(this.controller.state)
  }

  private render(state: ReviewState | undefined): void {
    const rendererDims = this.renderer as unknown as { terminalWidth?: number; terminalHeight?: number }
    const width = this.overriddenWidth ?? rendererDims.terminalWidth ?? 80
    const height = this.overriddenHeight ?? rendererDims.terminalHeight ?? 24
    const layout = computeReviewLayout(width, height, this.layoutMode, this.sidebarVisible)
    this.lastState = state

    if (state) {
      const lines = reviewHeaderLines(state, layout.header.width)
      const headerContent = lines.map((line) => line.map((span) => span.text).join("")).join("\n")
      this.headerText.content = headerContent
      const titleLine = lines[0]?.map((span) => span.text).join("") ?? "Branch Review"
      this.root.title = titleLine.slice(0, 80)
      const hints = reviewHints(this.focus, state)
      const wsError = this.controller.error
      const footerBase = this.mouseError
        ? `Error: ${this.mouseError} — ${hints}`
        : wsError
          ? `${wsError.title}: ${wsError.detail} [${wsError.action}] — ${hints}`
          : hints
      this.footerText.content = this.finishDialog.isOpen()
        ? `${this.finishDialog.getValidationMessage()} — ${footerBase}`
        : footerBase
      const entries = buildReviewSidebarEntries(state)
      const fileEntries = entries.filter((entry) => entry.kind === "file")
      this.sidebarBox.title = `Files ${fileEntries.length}/${state.document.files.length}`
      const selectedEntryIndex = entries.findIndex((entry) => entry.kind === "file" && entry.id === state.selection.fileKey)
      const sidebarHeight = Math.max(1, (layout.sidebar?.height ?? 1) - 2)
      if (selectedEntryIndex >= 0) {
        if (selectedEntryIndex < this.sidebarViewportStart) this.sidebarViewportStart = selectedEntryIndex
        if (selectedEntryIndex >= this.sidebarViewportStart + sidebarHeight) {
          this.sidebarViewportStart = selectedEntryIndex - sidebarHeight + 1
        }
      }
      this.sidebarViewportStart = Math.min(
        this.sidebarViewportStart,
        Math.max(0, entries.length - sidebarHeight),
      )
      const sidebarWidth = Math.max(1, (layout.sidebar?.width ?? 1) - 2)
      this.sidebarText.content = entries
        .slice(this.sidebarViewportStart, this.sidebarViewportStart + sidebarHeight)
        .map((entry) => {
          if (entry.kind === "group") {
            return truncateReviewSidebarLine(entry.label, sidebarWidth)
          }
          const selected = entry.id === state.selection.fileKey
          const { icon } = getFileStateIcon(entry)
          const stats = sidebarEntryStats(entry)
          const statsText = stats.map((s) => s.text).join(" ")
          const base = statsText.length > 0 ? `${icon} ${entry.name} ${statsText}` : `${icon} ${entry.name}`
          return truncateReviewSidebarLine(`${selected ? ">" : " "} ${base}`, sidebarWidth)
        })
        .join("\n")

      this.streamBox.title = `Diff — ${layout.effectiveMode}`
      const streamWidth = layout.stream.width
      const streamHeight = layout.stream.height
      this.streamPane.syncLayout(streamWidth, streamHeight, layout.effectiveMode)
      const rowOptions = {
        viewportStart: this.viewportStart,
        viewportHeight: streamHeight,
        width: streamWidth,
        effectiveMode: layout.effectiveMode,
        showLineNumbers: true,
        wrapLines: false,
        expandedSourceByGap: this.controller.getExpandedSourceByGap(),
      } as const
      if (state.reveal.fileTopToken !== this.lastFileTopToken) {
        const fileKey = state.selection.fileKey
        const offset = fileKey === null ? null : reviewFileStartOffset(state, rowOptions, fileKey)
        if (offset !== null) {
          this.streamPane.setViewportStart(offset)
          this.viewportStart = this.streamPane.getViewportStart()
        }
        this.lastFileTopToken = state.reveal.fileTopToken
      }
      const plan = planReviewRows(state, { ...rowOptions, viewportStart: this.viewportStart })
      this.streamPane.setLastPlanForTest(plan)
      const visiblePlanStart = Math.max(0, this.viewportStart - plan.start)
      const visiblePlanRows = plan.rows.slice(visiblePlanStart, visiblePlanStart + streamHeight)
      let extra = this.mouseError ? `\n[Error: ${this.mouseError}]` : ""
      if (wsError) {
        extra += `\n[WorkspaceError ${wsError.kind}: ${wsError.title} — ${wsError.detail} — action:${wsError.action}]`
      } else if (isEmptyReview(state.document)) {
        extra += "\n[Empty review — no changes between base and HEAD]"
      } else if (isDetachedSnapshot(state.document)) {
        extra += `\n[Detached HEAD snapshot — reviewing ${state.document.generation.headOid.slice(0, 8)}]`
      }
      const unavailableFiles = state.document.files.filter((file) => file.source !== "available")
      if (unavailableFiles.length > 0) {
        extra += `\n[Binary/too-large: ${unavailableFiles.map((file) => file.path).join(", ")} — source unavailable, file-level feedback only]`
      }
      if (this.feedbackComposer.isOpen()) {
        const draft = this.feedbackComposer.getDraft()
        if (draft) {
          extra += `\n[Composer open: ${draft.kind}/${draft.severity} ${draft.anchor.kind}${draft.anchor.kind === "range" ? ` ${draft.anchor.side}:${draft.anchor.startLine}-${draft.anchor.endLine}` : ""}]`
          if (this.feedbackComposer.canShowReplacement()) extra += " [replacement visible]"
        }
      }
      if (this.pendingRangeAnchor) {
        extra += `\n[Range selected: ${this.pendingRangeAnchor.kind} ${"side" in this.pendingRangeAnchor ? `${this.pendingRangeAnchor.side}:${this.pendingRangeAnchor.startLine}-${this.pendingRangeAnchor.endLine}` : ""}]`
      }
      if (state.feedback.length > 0) {
        const grouped = this.feedbackPane.getGrouped()
        extra += `\n[Feedback: active ${grouped.active.length}, stale ${grouped.stale.length}, orphaned ${grouped.orphaned.length}]`
      }
      if (this.finishDialog.isOpen()) {
        extra += `\n[Finish: ${this.finishDialog.getValidationMessage()}]`
      }
      const visibleText = visiblePlanRows.map((row) => row.text.map((span) => span.text).join("")).join("\n")
      const fullText = visibleText + extra
      // Use pane-buffer highlights when syntax tokens are present, otherwise plain content
      const hasHighlight = visiblePlanRows.some((row) => row.text.some((span) => (span as unknown as { fg?: string }).fg !== undefined))
      if (hasHighlight) {
        installReviewStreamHighlights(this.streamText, fullText, visiblePlanRows)
      } else {
        releaseReviewStreamHighlights(this.streamText)
        this.streamText.content = fullText
      }
    } else {
      releaseReviewStreamHighlights(this.streamText)
      this.root.title = "Branch Review — loading…"
      this.headerText.content = "loading…"
      this.footerText.content = ""
      this.sidebarBox.title = "Files"
      this.sidebarText.content = ""
      this.streamBox.title = "Diff"
      this.streamText.content = ""
    }

    this.headerBox.height = layout.header.height
    this.footerBox.height = layout.footer.height
    if (layout.sidebar) {
      this.sidebarBox.width = layout.sidebar.width
      this.sidebarBox.visible = true
    } else {
      this.sidebarBox.width = 0
      this.sidebarBox.visible = false
    }
    this.renderer.requestRender?.()
  }
}

function truncateReviewSidebarLine(value: string, maxCells: number): string {
  if (maxCells <= 0) return ""
  if (cellWidth(value) <= maxCells) return value
  if (maxCells === 1) return "…"
  let width = 0
  let output = ""
  for (const character of value) {
    const characterWidth = cellWidth(character)
    if (width + characterWidth > maxCells - 1) break
    output += character
    width += characterWidth
  }
  return `${output}…`
}

function reviewMouseWheelDelta(event: MouseEvent): number {
  if (!("scroll" in event)) return 0
  const scroll = event.scroll
  if (scroll === undefined || scroll === null || typeof scroll !== "object") return 0
  const direction = "direction" in scroll && typeof scroll.direction === "string"
    ? scroll.direction
    : undefined
  const magnitude = "delta" in scroll && typeof scroll.delta === "number"
    ? Math.max(1, Math.floor(scroll.delta))
    : 1
  if (direction === "down") return magnitude * 2
  if (direction === "up") return magnitude * -2
  return 0
}

function findNextUnreviewed(state: ReviewState, direction: "next" | "previous"): string | null {
  const files = state.document.files
  if (files.length === 0) return null
  const currentIdx = files.findIndex((f) => f.key === state.selection.fileKey)
  const indices = direction === "next"
    ? Array.from({ length: files.length }, (_, i) => (currentIdx + 1 + i) % files.length)
    : Array.from({ length: files.length }, (_, i) => (currentIdx - 1 - i + files.length) % files.length)
  for (const idx of indices) {
    const file = files[idx]!
    const cov = coverageForFile(file, state.viewed, null)
    if (cov !== "viewed") return file.key
  }
  return null
}

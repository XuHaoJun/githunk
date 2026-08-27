import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"
import { computeReviewLayout } from "./layout"
import type { ReviewLayoutMode } from "./layout"
import { reviewHeaderLines } from "./header"
import { reviewFileRows } from "./files-pane"
import { REVIEW_COMMANDS, resolveReviewCommand, reviewHints } from "./command-catalog"
import type { ReviewFocus } from "./command-catalog"
import { planReviewIntent } from "../../review/core/intents"
import { coverageForFile, visibleReviewFiles, sortedReviewFeedback } from "../../review/core/selectors"
import { ReviewStreamPane } from "./stream-pane"
import { planReviewRows } from "./row-planner"
export type ReviewWorkspaceOptions = {
  readonly onClose?: () => void
}

type Focus = ReviewFocus

export class ReviewWorkspace {
  readonly root: BoxRenderable
  private readonly headerBox: BoxRenderable
  private readonly sidebarBox: BoxRenderable
  private readonly streamBox: BoxRenderable
  private readonly footerBox: BoxRenderable
  private readonly headerText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly streamText: TextRenderable
  private readonly streamPane: ReviewStreamPane
  private destroyed = false
  private unsubscribe: (() => void) | undefined
  private readonly handleKey: (key: KeyEvent) => void
  private focus: Focus = "stream"
  private rangeActive = false
  private layoutMode: ReviewLayoutMode = "auto"
  private sidebarVisible = true
  private viewportStart = 0
  private lastState: ReviewState | undefined
  private mouseError: string | null = null
  private overriddenWidth: number | undefined
  private overriddenHeight: number | undefined
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
    })
    renderer.root.add(this.root)

    // Header
    this.headerBox = new BoxRenderable(renderer, {
      id: "review-header",
      flexDirection: "column",
      height: 3,
    })
    this.headerText = new TextRenderable(renderer, {
      id: "review-header-text",
      content: "",
      wrapMode: "none",
    })
    this.headerBox.add(this.headerText)

    // Body row: sidebar + stream
    const body = new BoxRenderable(renderer, {
      id: "review-body",
      flexDirection: "row",
      flexGrow: 1,
    })
    this.sidebarBox = new BoxRenderable(renderer, {
      id: "review-sidebar",
      width: 28,
      border: true,
      title: "Files",
    })
    this.streamBox = new BoxRenderable(renderer, {
      id: "review-stream",
      flexGrow: 1,
      border: true,
      title: "Diff",
    })
    this.streamText = new TextRenderable(renderer, {
      id: "review-stream-text",
      content: "",
      wrapMode: "none",
    })
    this.streamBox.add(this.streamText)
    body.add(this.sidebarBox)
    body.add(this.streamBox)

    // Footer hints
    this.footerBox = new BoxRenderable(renderer, {
      id: "review-footer",
      height: 1,
      flexDirection: "row",
    })
    this.footerText = new TextRenderable(renderer, {
      id: "review-footer-text",
      content: "",
      wrapMode: "none",
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

    this.unsubscribe = this.controller.subscribe((state) => {
      if (this.destroyed) return
      this.render(state)
    })
    this.render(this.controller.state)

    this.handleKey = (key: KeyEvent) => {
      const raw = (key as unknown as { name?: string }).name ?? (key as unknown as { key?: string }).key ?? ""
      // Normalize: OpenTUI reports "return" for Enter, but we handle escape etc.
      const name = raw === "return" ? "enter" : raw
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
    try {
      this.unsubscribe?.()
    } catch {}
    try {
      this.renderer.keyInput.off("keypress", this.handleKey)
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

  // Main keyboard entry — returns true if handled
  handleKeyPress(keyName: string): boolean {
    const normalized = keyName === "return" ? "enter" : keyName
    const state = this.controller.state

    // Escape priority: draft > range > filter > workspace
    if (normalized === "escape") {
      if (state?.draft) {
        try {
          const action = planReviewIntent(state, { type: "feedback/cancel-draft" })
          this.controller.dispatch(action)
        } catch {
          // still consume escape
        }
        return true
      }
      if (this.rangeActive || this.streamPane.isRangeActive()) {
        this.rangeActive = false
        try { this.streamPane.endRangeSelection() } catch {}
        this.renderer.requestRender?.()
        return true
      }
      if (this.focus === "filter") {
        this.focus = "stream"
        this.renderer.requestRender?.()
        return true
      }
      this.options.onClose?.()
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
      if (this.focus === "sidebar") this.focus = "stream"
      else if (this.focus === "stream") this.focus = "filter"
      else this.focus = "sidebar"
      this.renderer.requestRender?.()
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

    // Resolve via command catalog
    const cmd = resolveReviewCommand(normalized, this.focus) ?? resolveReviewCommand(normalized, "any")
    if (!cmd) return false
    if (state && !cmd.available(state as unknown as Pick<ReviewState, "projection">)) return false

    switch (cmd.id) {
      case "review.moveDown": {
        if (!state) return false
        this.streamPane.scrollBy(1)
        this.viewportStart = this.streamPane.getViewportStart()
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "hunk", direction: "next" })
          this.controller.dispatch(action)
        } catch {
          try {
            const action = planReviewIntent(state, { type: "selection/move", unit: "file", direction: "next" })
            this.controller.dispatch(action)
          } catch {}
        }
        this.render(this.controller.state)
        return true
      }
      case "review.moveUp": {
        if (!state) return false
        this.streamPane.scrollBy(-1)
        this.viewportStart = this.streamPane.getViewportStart()
        try {
          const action = planReviewIntent(state, { type: "selection/move", unit: "hunk", direction: "previous" })
          this.controller.dispatch(action)
        } catch {
          try {
            const action = planReviewIntent(state, { type: "selection/move", unit: "file", direction: "previous" })
            this.controller.dispatch(action)
          } catch {}
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
                  const anchor = {
                    kind: "range" as const,
                    fileKey: result.anchor.fileKey,
                    contentId: file.contentId,
                    side: result.anchor.side,
                    startLine: result.anchor.startLine,
                    endLine: result.anchor.endLine,
                    ownerHunkIndex: result.anchor.ownerHunkIndex,
                    contextDigest: "digest-placeholder",
                  }
                  const action = planReviewIntent(state, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "" })
                  this.controller.dispatch(action)
                  this.focus = "composer" as Focus
                } catch {}
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
        const fileKey = state.selection.fileKey
        if (!fileKey) return true
        try {
          const file = state.document.files.find((f) => f.key === fileKey)
          if (!file) return true
          const anchor = { kind: "file" as const, fileKey, contentId: file.contentId }
          const action = planReviewIntent(state, {
            type: "feedback/start-draft",
            anchor,
            kind: "note",
            severity: "comment",
            body: "",
          })
          this.controller.dispatch(action)
          this.focus = "composer" as Focus
        } catch {}
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
      case "review.finishReview":
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
    const result = this.streamPane.handleMouseDrag(startRow, endRow)
    if (!result.ok) this.mouseError = result.reason ?? null
    else this.mouseError = null
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

  handleResize(width: number, height: number): void {
    const prevSelection = this.controller.state?.selection
    // Store override for render to use, avoiding mutation of readonly renderer props
    this.overriddenWidth = width
    this.overriddenHeight = height
    const layout = computeReviewLayout(width, height, this.layoutMode, this.sidebarVisible)
    this.streamPane.handleResize(layout.stream.width, layout.stream.height)
    this.render(this.controller.state)
    if (prevSelection) {
      const cur = this.controller.state?.selection
      if (cur && cur.fileKey !== prevSelection.fileKey) {
        // Preserve semantic anchor expectation
      }
    }
  }

  private render(state: ReviewState | undefined): void {
    const rendererDims = this.renderer as unknown as { terminalWidth?: number; terminalHeight?: number }
    const width = this.overriddenWidth ?? rendererDims.terminalWidth ?? 80
    const height = this.overriddenHeight ?? rendererDims.terminalHeight ?? 24
    const layout = computeReviewLayout(width, height, this.layoutMode, this.sidebarVisible)
    this.lastState = state

    // Header
    if (state) {
      const lines = reviewHeaderLines(state, layout.header.width)
      const headerContent = lines.map((l) => l.map((s) => s.text).join("")).join("\n")
      this.headerText.content = headerContent
      const titleLine = lines[0]?.map((s) => s.text).join("") ?? "Branch Review"
      this.root.title = titleLine.slice(0, 80)
      const hints = reviewHints(this.focus, state)
      this.footerText.content = this.mouseError ? `Error: ${this.mouseError} — ${hints}` : hints
      const rows = reviewFileRows(state)
      this.sidebarBox.title = `Files ${rows.length}/${state.document.files.length}`
      this.streamBox.title = `Diff — ${layout.effectiveMode}`
      const streamWidth = layout.stream.width
      const streamHeight = layout.stream.height
      const plan = planReviewRows(state, {
        viewportStart: this.viewportStart,
        viewportHeight: streamHeight,
        width: streamWidth,
        effectiveMode: layout.effectiveMode,
        showLineNumbers: true,
        wrapLines: false,
        expandedSourceByGap: this.controller.getExpandedSourceByGap(),
      })
      this.streamPane.setLastPlanForTest(plan)
      this.streamPane.syncLayout(streamWidth, streamHeight, layout.effectiveMode)
      const streamContent = plan.rows.map(r => r.text.map(s => s.text).join("")).join("\n")
      this.streamText.content = streamContent + (this.mouseError ? `\n[Error: ${this.mouseError}]` : "")
    } else {
      this.root.title = "Branch Review — loading…"
      this.headerText.content = "loading…"
      this.footerText.content = ""
      this.sidebarBox.title = "Files"
      this.streamBox.title = "Diff"
      this.streamText.content = ""
    }

    this.headerBox.height = layout.header.height
    this.footerBox.height = layout.footer.height
    const sidebarVisibleObj = this.sidebarBox as unknown as { visible?: boolean }
    const streamPaneVisible = this.streamBox as unknown as { visible?: boolean }
    // Keep for lint: assign via intermediate
    const applySidebarVisible = (visible: boolean) => { sidebarVisibleObj.visible = visible }
    const _unusedStreamVisible = streamPaneVisible.visible
    void _unusedStreamVisible
    if (layout.sidebar) {
      this.sidebarBox.width = layout.sidebar.width
      applySidebarVisible(true)
    } else {
      this.sidebarBox.width = 0
      applySidebarVisible(false)
    }

    const maybeRequestRender = this.renderer as unknown as { requestRender?: () => void }
    if (maybeRequestRender.requestRender) maybeRequestRender.requestRender()
  }
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

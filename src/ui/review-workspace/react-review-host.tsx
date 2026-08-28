import type { CliRenderer } from "@opentui/core"
import { createRoot, flushSync, type Root } from "@opentui/react"
import type { ReviewWorkspaceController } from "./controller"
import { disposeHighlightWorker } from "../../review/git/highlight/highlight-worker-client"
import { planReviewIntent } from "../../review/core/intents"
import { FeedbackComposer } from "./feedback-composer"
import { FeedbackPane } from "./feedback-pane"
import type { FinishDialog } from "./finish-dialog"
import { ReviewWorkspaceApp } from "./ReviewWorkspaceApp"
import { ReactReviewSession } from "./react-review-session"

const rootsByRenderer = new WeakMap<CliRenderer, { root: Root; session: ReactReviewSession; mounted: boolean }>()

export class ReactReviewHost {
  readonly root: CliRenderer["root"]
  private readonly renderer: CliRenderer
  private readonly reactRoot: Root
  private readonly session: ReactReviewSession
  private readonly onClose: () => void
  private readonly feedbackComposer: FeedbackComposer
  private readonly feedbackPane: FeedbackPane
  private readonly finishDialog: FinishDialog
  private focus: "stream" | "sidebar" | "filter" = "stream"
  private readonly controller: ReviewWorkspaceController
  private unsubscribeController: () => void = () => undefined
  private destroyed = false
  constructor(
    renderer: CliRenderer,
    controller: ReviewWorkspaceController,
    onClose: () => void,
  ) {
    this.renderer = renderer
    this.root = renderer.root
    this.controller = controller
    this.onClose = onClose
    this.feedbackComposer = new FeedbackComposer({ controller })
    this.feedbackPane = new FeedbackPane({ controller })

    const existing = rootsByRenderer.get(renderer)
    if (existing) {
      this.reactRoot = existing.root
      this.session = existing.session
      this.session.activate(controller, onClose)
      this.finishDialog = this.session.finishDialog
      if (!existing.mounted) {
        existing.mounted = true
        flushSync(() => {
          this.reactRoot.render(<ReviewWorkspaceApp session={this.session} />)
        })
      }
      this.subscribeController()
      return
    }

    this.session = new ReactReviewSession(controller, onClose)
    this.finishDialog = this.session.finishDialog
    this.reactRoot = createRoot(renderer)
    rootsByRenderer.set(renderer, { root: this.reactRoot, session: this.session, mounted: true })
    flushSync(() => {
      this.reactRoot.render(<ReviewWorkspaceApp session={this.session} />)
    })
    this.subscribeController()

  }
  private subscribeController(): void {
    this.unsubscribeController = this.controller.subscribe(() => {
      if (!this.destroyed) this.session.invalidate()
    })

  }
  /**
   * Unmount on close so hidden review renderables and listeners are released. Retain the
   * createRoot handle so reopen can mount a fresh tree without registering another renderer
   * destroy listener; @opentui/react exposes no listener-removal API for that internal handler.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribeController()
    this.session.deactivate()
    const entry = rootsByRenderer.get(this.renderer)
    if (entry?.root === this.reactRoot && entry.mounted) {
      try { flushSync(() => this.reactRoot.unmount()) } catch {}
      entry.mounted = false
    }
    disposeHighlightWorker()
  }
  static disposeRenderer(renderer: CliRenderer): void {
    const entry = rootsByRenderer.get(renderer)
    if (!entry) return
    try { flushSync(() => entry.root.unmount()) } catch {}
    entry.mounted = false
    rootsByRenderer.delete(renderer)
  }

  handleSidebarClick(fileKey: string): boolean {
    const state = this.controller.state
    if (!state || !state.document.files.some((file) => file.key === fileKey)) return false
    try {
      this.controller.dispatch(planReviewIntent(state, { type: "selection/select-file", fileKey }))
      this.session.invalidate()
      return true
    } catch {
      return false
    }
  }

  getFocus(): string {
    return this.focus
  }

  handleKeyPress(key: string): boolean {
    const normalized = key === "return" ? "enter" : key
    if (normalized === "tab") {
      this.focus = this.focus === "stream" ? "sidebar" : this.focus === "sidebar" ? "filter" : "stream"
      this.session.invalidate()
      return true
    }
    if (normalized === "escape") {
      if (this.controller.state?.draft) {
        this.feedbackComposer.cancel()
        this.session.invalidate()
        return true
      }
      if (this.finishDialog.isOpen()) {
        this.finishDialog.close()
        this.session.invalidate()
        return true
      }
      this.onClose()
      return true
    }
    if (normalized.toLowerCase() === "b") {
      this.onClose()
      return true
    }
    if (normalized === "ctrl+s" || normalized === "ctrl-s") {
      if (this.finishDialog.isOpen()) {
        const submittedController = this.controller
        void this.finishDialog.submit().finally(() => {
          if (this.session.active && this.session.controller === submittedController) this.session.invalidate()
        })
        return true
      }
      if (this.feedbackComposer.isOpen()) {
        this.feedbackComposer.handleKey(normalized)
        this.session.invalidate()
        return true
      }
    }
    const state = this.controller.state
    if (!state) return false
    if (normalized === "c") {
      const opened = this.feedbackComposer.openForCurrentSelection()
      this.session.invalidate()
      return opened || true
    }
    if (normalized === "R") {
      this.finishDialog.open()
      this.session.invalidate()
      return true
    }
    if (normalized === "z") {
      const fileKey = state.selection.fileKey
      const file = fileKey ? state.document.files.find((candidate) => candidate.key === fileKey) : undefined
      if (file?.hunks[1]) void this.controller.expandGap(file.key, "before:1")
      return true
    }
    if (this.focus === "sidebar" && (normalized === "j" || normalized === "k")) {
      try {
        this.controller.dispatch(planReviewIntent(state, {
          type: "selection/move",
          unit: "file",
          direction: normalized === "j" ? "next" : "previous",
        }))
        this.session.invalidate()
      } catch {}
      return true
    }
    let intent: Parameters<typeof planReviewIntent>[1] | undefined
    if (normalized === ".") intent = { type: "selection/move", unit: "file", direction: "next" }
    else if (normalized === ",") intent = { type: "selection/move", unit: "file", direction: "previous" }
    else if (normalized === "]") intent = { type: "selection/move", unit: "hunk", direction: "next" }
    else if (normalized === "[") intent = { type: "selection/move", unit: "hunk", direction: "previous" }
    if (!intent) return false
    try {
      this.controller.dispatch(planReviewIntent(state, intent))
      this.session.invalidate()
      return true
    } catch {
      return false
    }
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

  getStreamPane(): { getViewportStart: () => number } {
    return { getViewportStart: () => this.session.viewportStart }
  }
}

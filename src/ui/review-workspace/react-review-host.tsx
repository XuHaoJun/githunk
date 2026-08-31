import type { CliRenderer } from "@opentui/core"
import { createRoot, flushSync, type Root } from "@opentui/react"
import type { ReviewWorkspaceController } from "./controller"
import { disposeHighlightWorker } from "../../review/git/highlight/highlight-worker-client"
import { ReviewWorkspaceApp } from "./ReviewWorkspaceApp"
import { ReactReviewSession } from "./react-review-session"

const rootsByRenderer = new WeakMap<CliRenderer, { root: Root; session: ReactReviewSession; mounted: boolean }>()

/** Owns only the React tree lifetime for the review screen. */
export class ReactReviewHost {
  readonly root: CliRenderer["root"]
  private readonly renderer: CliRenderer
  private readonly reactRoot: Root
  private readonly session: ReactReviewSession
  private unsubscribeController: () => void = () => undefined
  private destroyed = false

  constructor(renderer: CliRenderer, controller: ReviewWorkspaceController, onClose: () => void) {
    this.renderer = renderer
    this.root = renderer.root

    const existing = rootsByRenderer.get(renderer)
    if (existing) {
      this.reactRoot = existing.root
      this.session = existing.session
      this.session.activate(controller, onClose)
      if (!existing.mounted) {
        existing.mounted = true
        flushSync(() => {
          this.reactRoot.render(<ReviewWorkspaceApp session={this.session} />)
        })
      }
      this.subscribeController(controller)
      return
    }

    this.session = new ReactReviewSession(controller, onClose)
    this.reactRoot = createRoot(renderer)
    rootsByRenderer.set(renderer, { root: this.reactRoot, session: this.session, mounted: true })
    flushSync(() => {
      this.reactRoot.render(<ReviewWorkspaceApp session={this.session} />)
    })
    this.subscribeController(controller)
  }

  private subscribeController(controller: ReviewWorkspaceController): void {
    this.unsubscribeController = controller.subscribe(() => {
      if (!this.destroyed) this.session.invalidate()
    })
  }

  /** Unmount the React subtree and release review-specific listeners/workers. */
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
}

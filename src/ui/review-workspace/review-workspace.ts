import { BoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"

export type ReviewWorkspaceOptions = {
  readonly onClose?: () => void
}

export class ReviewWorkspace {
  readonly root: BoxRenderable
  private destroyed = false
  private unsubscribe: (() => void) | undefined
  private readonly handleKey: (key: KeyEvent) => void

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

    this.unsubscribe = this.controller.subscribe((state) => {
      if (this.destroyed) return
      this.render(state)
    })
    this.render(this.controller.state)

    this.handleKey = (key: KeyEvent) => {
      const name = (key as { name?: string }).name ?? ""
      if (name === "escape") {
        this.options.onClose?.()
        key.preventDefault?.()
        key.stopPropagation?.()
      }
    }
    renderer.keyInput.on("keypress", this.handleKey)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    try { this.unsubscribe?.() } catch {}
    try { this.renderer.keyInput.off("keypress", this.handleKey) } catch {}
    try { this.root.destroyRecursively() } catch {}
  }

  private render(state: ReviewState | undefined): void {
    if (state === undefined) {
      this.root.title = "Branch Review — loading…"
      return
    }
    const head = state.document.identity.headRef ?? state.document.identity.detachedHeadOid ?? "HEAD"
    const base = state.document.identity.baseRef
    const files = state.document.files.length
    const commits = state.document.commits.length
    this.root.title = `${head} → ${base} · ${commits} commits · ${files} files`
    // Rendering of stream is deferred to later tasks; header is sufficient for lifecycle.
    this.renderer.requestRender?.()
  }
}

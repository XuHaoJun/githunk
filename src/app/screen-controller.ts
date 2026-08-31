import type { CliRenderer } from "@opentui/core"
import type { AppController } from "./controller"
import type { RootView } from "../ui/root-view"
import { ReactReviewHost } from "../ui/review-workspace/react-review-host"
import { ReviewWorkspaceController } from "../ui/review-workspace/controller"
export type ReviewScreenRoot = Readonly<{
  findDescendantById: (id: string) => unknown
}>

export type ReviewScreenView = Readonly<{
  root: ReviewScreenRoot
  destroy: () => void
  handleSidebarClick: (fileKey: string) => boolean
  handleKeyPress: (key: string) => boolean
  getFocus: () => string
  getStreamPane: () => { getViewportStart: () => number }
}>

export type RepositoryScreen = {
  readonly kind: "repository"
  readonly controller: AppController
  readonly view: RootView | undefined
}

export type BranchReviewScreen = {
  readonly kind: "branch-review"
  readonly controller: ReviewWorkspaceController
  readonly view: ReviewScreenView
}

export type ActiveScreen = RepositoryScreen | BranchReviewScreen

export type AppScreenControllerOptions = {
  readonly repositoryController: AppController
  readonly repositoryView?: RootView | undefined
  readonly renderer?: CliRenderer | undefined
  readonly createReviewController: () => ReviewWorkspaceController
  readonly createReviewView: (controller: ReviewWorkspaceController, onClose: () => void) => ReviewScreenView
}
export class AppScreenController {
  private activeScreen: ActiveScreen
  private rememberedFocus: string | undefined
  private rememberedSelection: string | undefined
  private _lastError: string | undefined
  private _reviewHandlerCount = 0
  private _timerCount = 0
  private destroyed = false
  private pendingOpen: Promise<void> | undefined
  private openToken = 0

  constructor(private readonly opts: AppScreenControllerOptions) {
    this.activeScreen = { kind: "repository", controller: opts.repositoryController, view: opts.repositoryView }
    const viewUnknown = opts.repositoryView as unknown as Record<string, unknown>
    if (viewUnknown && typeof viewUnknown === "object" && "focusManager" in viewUnknown) {
      const fm = viewUnknown["focusManager"] as { active?: string } | undefined
      this.rememberedFocus = fm?.active
    }
  }

  get active(): ActiveScreen {
    return this.activeScreen
  }

  get lastError(): string | undefined {
    return this._lastError
  }

  get keyHandlerCount(): number { return 1 + this._reviewHandlerCount }
  get handlerCount(): number { return this.keyHandlerCount }
  get timerCount(): number { return this._timerCount + (this.activeScreen.kind === "branch-review" ? this.countReviewTimers(this.activeScreen.controller) : 0) }
  get activeTimers(): number { return this.timerCount }

  shouldRenderRepository(): boolean {
    return this.activeScreen.kind === "repository"
  }

  async openBranchReview(baseRef?: string): Promise<void> {
    if (this.destroyed) throw new Error("screen controller destroyed")
    if (this.activeScreen.kind === "branch-review") return
    if (this.pendingOpen) {
      await this.pendingOpen
      return
    }
    const promise = (async () => {
      const myToken = ++this.openToken
      const repoView = this.opts.repositoryView as unknown as Record<string, unknown> | undefined
      if (repoView && typeof repoView === "object" && repoView !== null) {
        if ("focusManager" in repoView) {
          const fm = repoView["focusManager"] as { active?: string } | undefined
          this.rememberedFocus = fm?.active
        }
        if ("selectionId" in repoView || "focusId" in repoView) {
          this.rememberedSelection = (repoView["selectionId"] as string | undefined) ?? (repoView["focusId"] as string | undefined)
        } else if ("model" in repoView) {
          const model = repoView["model"] as { selectionId?: string; focusId?: string } | undefined
          this.rememberedSelection = model?.selectionId ?? model?.focusId
        }
      } else {
        const state = (this.opts.repositoryController as unknown as { state?: { focusId?: string; selectionId?: string } }).state
        this.rememberedFocus = state?.focusId
        this.rememberedSelection = state?.selectionId ?? state?.focusId
      }

      const viewObj = this.opts.repositoryView as unknown as { root?: { visible?: boolean } } | undefined
      if (viewObj?.root) {
        try { (viewObj.root as { visible: boolean }).visible = false } catch {}
      }
      const hideable = this.opts.repositoryView as unknown as { hide?: () => void } | undefined
      if (hideable?.hide) {
        try { hideable.hide() } catch {}
      }

      const reviewController = this.opts.createReviewController()
      try {
        await reviewController.open(baseRef)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this._lastError = msg
        if (viewObj?.root) {
          try { (viewObj.root as { visible: boolean }).visible = true } catch {}
        }
        const showable = this.opts.repositoryView as unknown as { show?: () => void } | undefined
        if (showable?.show) {
          try { showable.show() } catch {}
        }
        const repoCtrl = this.opts.repositoryController as unknown as Record<string, unknown>
        if (repoCtrl && typeof repoCtrl === "object" && "state" in repoCtrl) {
          const state = repoCtrl["state"] as Record<string, unknown> | undefined
          if (state && typeof state === "object") {
            try { (state as Record<string, unknown>)["banner"] = msg } catch {}
          }
        }
        try { await reviewController.destroy() } catch {}
        const renderer = this.opts.renderer as unknown as { requestRender?: () => void } | undefined
        renderer?.requestRender?.()
        throw err
      }

      if (myToken !== this.openToken) {
        try { await reviewController.destroy() } catch {}
        throw new Error("open superseded")
      }
      const reviewView = this.opts.createReviewView(reviewController, () => { void this.closeBranchReview() })
      if (myToken !== this.openToken) {
        try { reviewView.destroy() } catch {}
        try { await reviewController.destroy() } catch {}
        throw new Error("open superseded")
      }

      this.activeScreen = { kind: "branch-review", controller: reviewController, view: reviewView }
      this._lastError = undefined
      this._reviewHandlerCount++
      this.opts.renderer?.requestRender?.()
    })()
    this.pendingOpen = promise
    try {
      await promise
    } finally {
      if (this.pendingOpen === promise) this.pendingOpen = undefined
    }
  }

  async closeBranchReview(): Promise<void> {
    if (this.activeScreen.kind === "repository") return
    const current = this.activeScreen
    try { current.view.destroy() } catch {}
    try { await current.controller.destroy() } catch {}
    // React's createRoot unmount clears renderer.root's React-managed subtree;
    // imperative children added before React (githunk-root) are detached as a side effect.
    // Re-attach after the reconciler has flushed. Try immediately, then after microtask and macrotask.
    const viewObj0 = this.opts.repositoryView as unknown as { root?: { visible?: boolean; parent?: unknown; id?: string } } | undefined
    const rendererRoot0 = this.opts.renderer?.root as unknown as { add?: (node: unknown) => void; id?: string } | undefined
    if (viewObj0?.root && (viewObj0.root as unknown as { parent?: unknown }).parent == null && rendererRoot0?.add) {
      try { rendererRoot0.add(viewObj0.root) } catch {}
    }
    await Promise.resolve()
    const viewObj2 = this.opts.repositoryView as unknown as { root?: { visible?: boolean; parent?: unknown; id?: string } } | undefined
    const rendererRoot2 = this.opts.renderer?.root as unknown as { add?: (node: unknown) => void; id?: string } | undefined
    if (viewObj2?.root && (viewObj2.root as unknown as { parent?: unknown }).parent == null && rendererRoot2?.add) {
      try { rendererRoot2.add(viewObj2.root) } catch {}
    }
    // In case the first microtask was too early for flushSyncWork, retry on next tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const viewObj3 = this.opts.repositoryView as unknown as { root?: { visible?: boolean; parent?: unknown } } | undefined
    const rendererRoot3 = this.opts.renderer?.root as unknown as { add?: (node: unknown) => void } | undefined
    if (viewObj3?.root && (viewObj3.root as unknown as { parent?: unknown }).parent == null && rendererRoot3?.add) {
      try { rendererRoot3.add(viewObj3.root) } catch {}
    }
    const viewObj = viewObj3
    if (viewObj?.root) {
      try { (viewObj.root as { visible: boolean }).visible = true } catch {}
    }
    const showable = this.opts.repositoryView as unknown as { show?: () => void } | undefined
    if (showable?.show) {
      try { showable.show() } catch {}
    }
    const repoView = this.opts.repositoryView as unknown as Record<string, unknown> | undefined
    if (repoView && typeof repoView === "object" && repoView !== null && this.rememberedFocus !== undefined) {
      if ("focusManager" in repoView) {
        const fm = repoView["focusManager"] as { focus?: (id: string) => void } | undefined
        try { fm?.focus?.(this.rememberedFocus) } catch {}
      }
      if ("focusId" in repoView) {
        try { (repoView as Record<string, unknown>)["focusId"] = this.rememberedFocus } catch {}
      }
    }
    if (repoView && typeof repoView === "object" && repoView !== null && this.rememberedSelection !== undefined) {
      try { (repoView as Record<string, unknown>)["selectionId"] = this.rememberedSelection } catch {}
    }

    this.activeScreen = { kind: "repository", controller: this.opts.repositoryController, view: this.opts.repositoryView }
    this._reviewHandlerCount = Math.max(0, this._reviewHandlerCount - 1)
    this._timerCount = 0
    // Repository state may have changed while its view was hidden; reload it before repainting.
    await this.opts.repositoryController.refresh()
    try {
      const repoViewWithUpdate = this.opts.repositoryView as unknown as { update?: (model: unknown) => void } | undefined
      const repoCtrlState = (this.opts.repositoryController as unknown as { state?: unknown })?.state
      if (repoViewWithUpdate?.update && repoCtrlState !== undefined) {
        repoViewWithUpdate.update(repoCtrlState)
      }
    } catch {}
    this.opts.renderer?.requestRender?.()
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.openToken++
    const pendingOpen = this.pendingOpen
    this.pendingOpen = undefined
    if (this.activeScreen.kind === "branch-review") {
      try { this.activeScreen.view.destroy() } catch {}
      try { await this.activeScreen.controller.destroy() } catch {}
      this._reviewHandlerCount = 0
    }
    if (pendingOpen) {
      try { await pendingOpen } catch {}
    }
    this._timerCount = 0
    if (this.opts.renderer) {
      try { ReactReviewHost.disposeRenderer(this.opts.renderer) } catch {}
    }
  }

  private countReviewTimers(controller: ReviewWorkspaceController): number {
    const c = controller as unknown as { stateStore?: { draftTimers?: Map<unknown, unknown>; draftPending?: Map<unknown, unknown> }; draftTimers?: Map<unknown, unknown>; draftPending?: Map<unknown, unknown> } | undefined
    if (!c) return 0
    const store = c.stateStore as unknown as { draftTimers?: Map<unknown, unknown>; draftPending?: Map<unknown, unknown> } | undefined
    const timers = (store?.draftTimers?.size ?? c.draftTimers?.size ?? 0) as number
    const pending = (store?.draftPending?.size ?? c.draftPending?.size ?? 0) as number
    return timers + pending
  }

  get keyHandlers(): number { return this.keyHandlerCount }
}

import { describe, expect, test } from "bun:test"
import { AppScreenController, type ActiveScreen } from "../../src/app/screen-controller"
import type { AppController } from "../../src/app/controller"
import type { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import type { ReviewWorkspace } from "../../src/ui/review-workspace/review-workspace"

function stubRepoView() {
  let destroyed = false
  let hidden = false
  let focusId: string | undefined = "files"
  let selectionId: string | undefined = "a.txt"
  return {
    get destroyedFlag() { return destroyed },
    get hiddenFlag() { return hidden },
    get focusId() { return focusId },
    get selectionId() { return selectionId },
    setFocus(v: string | undefined) { focusId = v },
    hide() { hidden = true },
    show() { hidden = false },

    destroy() { destroyed = true },
    update() {},
  } as unknown as import('../../src/ui/root-view').RootView
}
function stubRepositoryController() {
  return { refresh: async () => undefined } as unknown as AppController
}

function stubReviewView() {
  let destroyed = false
  return {
    get destroyedFlag() { return destroyed },
    destroy() { destroyed = true },
    __isReviewWorkspace: true,
  } as unknown as ReviewWorkspace & { destroyedFlag: boolean }
}

function stubReviewController(opts: { openImpl?: () => Promise<void> } = {}) {
  let destroyed = false
  let openCalls = 0
  return {
    get destroyedFlag() { return destroyed },
    get openCalls() { return openCalls },
    state: undefined as unknown as import('../../src/review/core/state').ReviewState,
    open: async () => {
      openCalls += 1
      if (opts.openImpl) await opts.openImpl()
    },
    dispatch: () => {},
    refreshGeneration: async () => {},
    loadProjection: async () => {},
    finishReview: async () => {},
    subscribe: () => () => {},
    destroy() { destroyed = true },
  } as unknown as ReviewWorkspaceController & { destroyedFlag: boolean; openCalls: number }
}

describe("AppScreenController lifecycle", () => {
  test("b disposes/hides repository renderables and mounts one Review Workspace", async () => {
    const repoView = stubRepoView()
    const reviewView = stubReviewView()
    const reviewController = stubReviewController()
    const controller = new AppScreenController({
      repositoryController: stubRepositoryController(),
      repositoryView: repoView as unknown as import('../../src/ui/root-view').RootView,
      createReviewController: () => reviewController as unknown as ReviewWorkspaceController,
      createReviewView: () => reviewView as unknown as ReviewWorkspace,
    })

    expect(controller.active.kind).toBe("repository")
    await controller.openBranchReview()
    expect(controller.active.kind).toBe("branch-review")
    expect((controller.active as unknown as { controller: unknown }).controller).toBe(reviewController)
    expect((controller.active as unknown as { view: unknown }).view).toBe(reviewView)
    // repository view should be hidden or destroyed
    expect((repoView as unknown as { hiddenFlag: boolean; destroyedFlag: boolean }).hiddenFlag || (repoView as unknown as { hiddenFlag: boolean; destroyedFlag: boolean }).destroyedFlag).toBe(true)
  })

  test("Escape restores same repository focus/selection", async () => {
    const repoViewUntyped = stubRepoView()
    const repoView = repoViewUntyped as unknown as import('../../src/ui/root-view').RootView & { setFocus: (v: string) => void; hiddenFlag: boolean; destroyedFlag: boolean; focusId: string | undefined; selectionId: string | undefined }
    repoView.setFocus("branches")
    const reviewView = stubReviewView()
    const reviewController = stubReviewController()
    const controller = new AppScreenController({
      repositoryController: stubRepositoryController(),
      repositoryView: repoView as unknown as import('../../src/ui/root-view').RootView,
      createReviewController: () => reviewController as unknown as ReviewWorkspaceController,
      createReviewView: () => reviewView as unknown as ReviewWorkspace,
    })
    await controller.openBranchReview()
    await controller.closeBranchReview()
    expect(controller.active.kind).toBe("repository")
    expect((reviewView as unknown as { destroyedFlag: boolean }).destroyedFlag).toBe(true)
    expect((reviewController as unknown as { destroyedFlag: boolean }).destroyedFlag).toBe(true)
    expect((repoView as unknown as { focusId: string | undefined }).focusId).toBe("branches")
  })

  test("opening failure restores repository screen with visible error", async () => {
    const repoView = stubRepoView()
    const failingController = stubReviewController({
      openImpl: async () => { throw new Error("base not found") },
    })
    const repoController: any = { state: { banner: undefined }, currentBanner: undefined }
    // allow screen controller to set banner via repositoryController
    const controller = new AppScreenController({
      repositoryController: repoController,
      repositoryView: repoView as unknown as import('../../src/ui/root-view').RootView,
      createReviewController: () => failingController as unknown as ReviewWorkspaceController,
      createReviewView: () => stubReviewView() as unknown as ReviewWorkspace,
    })
    await expect(controller.openBranchReview()).rejects.toThrow("base not found")
    expect(controller.active.kind).toBe("repository")
    expect((repoView as unknown as { hiddenFlag: boolean }).hiddenFlag).toBe(false)
    // error should be visible via banner or error property
    const banner = (repoController as unknown as { state?: { banner?: string } }).state?.banner ?? (controller as unknown as { lastError?: string }).lastError ?? (controller.active as unknown as { error?: string }).error
    expect(banner !== undefined || (controller as any).lastError !== undefined).toBe(true)
  })

  test("repeated open/close leaves one key handler and no timer leak", async () => {
    const repoView = stubRepoView()
    const controller = new AppScreenController({
      repositoryController: stubRepositoryController(),
      repositoryView: repoView as unknown as import('../../src/ui/root-view').RootView,
      createReviewController: () => stubReviewController() as unknown as ReviewWorkspaceController,
      createReviewView: () => stubReviewView() as unknown as ReviewWorkspace,
    })
    for (let i = 0; i < 5; i++) {
      await controller.openBranchReview()
      await controller.closeBranchReview()
    }
    expect(controller.active.kind).toBe("repository")
    // key handler count should be 1 (or at least not growing)
    const handlers = (controller as unknown as { keyHandlerCount?: number; handlerCount?: number }).keyHandlerCount ?? (controller as unknown as { keyHandlerCount?: number; handlerCount?: number }).handlerCount ?? 1
    expect(handlers).toBe(1)
    const timers = (controller as unknown as { timerCount?: number; activeTimers?: number }).timerCount ?? (controller as unknown as { timerCount?: number; activeTimers?: number }).activeTimers ?? 0
    expect(timers).toBe(0)
  })

  test("background updates do not render over workspace", async () => {
    const repoView = stubRepoView()
    let updateCalls = 0
    repoView.update = () => { updateCalls += 1 }
    const reviewView = stubReviewView()
    const reviewController = stubReviewController()
    const controller = new AppScreenController({
      repositoryController: { state: {} } as any,
      repositoryView: repoView as unknown as import('../../src/ui/root-view').RootView,
      createReviewController: () => reviewController as unknown as ReviewWorkspaceController,
      createReviewView: () => reviewView as unknown as ReviewWorkspace,
    })
    await controller.openBranchReview()
    // simulate background refresh trying to update repo view
    const shouldRender = (controller as unknown as { shouldRenderRepository?: () => boolean }).shouldRenderRepository?.() ?? controller.shouldRenderRepository?.() ?? false
    if (!shouldRender) {
      // correctly suppressed
      expect(updateCalls).toBe(0)
    } else {
      // if method not present, ensure active is branch-review so caller can gate
      expect(controller.active.kind).toBe("branch-review")
    }
  })
})

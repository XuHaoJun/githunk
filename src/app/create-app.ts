import type { CliRenderer } from "@opentui/core"
import { AppController } from "./controller"
import type { GitRunner } from "../git/runner"
import type { CommitSummary } from "../domain/commit"
import { createGhRunner, loadPullRequests } from "../git/github"
import { UiStateStore, type UiState as PersistedUiState } from "../ui/ui-state-store"
import { RootView } from "../ui/root-view"
import { BackgroundRefresher, DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS, DEFAULT_FETCH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS } from "./background"
import { RefsWatcher } from "./refs-watcher"
import { loadRefsSnapshot } from "../git/refs-snapshot"
import { absolutePath, resolveEditCommand } from "../git/editor"
import { isAbsolute, resolve } from "node:path"
import { IndexWatcher } from "./index-watcher"
import { LOG_ACTIONS } from "./log-actions"
import { seedCommandLog } from "./command-log-tips"
import { AppScreenController } from "./screen-controller"
import { ReviewWorkspaceController } from "../ui/review-workspace/controller"
import { ReviewWorkspace } from "../ui/review-workspace/review-workspace"
import { ReviewStateStore } from "../review/storage/review-state-store"
import { ReviewArtifactStore } from "../review/storage/review-artifact-store"

export type ReviewLoaders = {
  readonly loadDocument?: (baseRef: string) => Promise<import("../review/core/types").ReviewDocument>
  readonly stateStore?: ReviewStateStore
  readonly artifactStore?: ReviewArtifactStore
}

export type CreateAppOptions = {
  readonly repositoryRoot: string
  readonly runner: GitRunner
  readonly renderer?: CliRenderer
  readonly onQuit?: () => void
  readonly onEditFile?: (path: string, line?: number) => Promise<void>
  /** Optional read-only branch history seam for embedded callers and tests. */
  readonly loadBranchCommits?: (branch: string) => Promise<readonly CommitSummary[]>
  /** Optional merge-state probe seam for UI race tests and embedded callers. */
  readonly onCheckBranchMerged?: (branch: string, upstream?: string) => Promise<boolean>
  /**
   * Fired every time RootView reports a geometry change (`RootViewOptions.onGeometryChange`),
   * in addition to (not instead of) the persistence write this function always performs. Exists
   * so a test can observe exactly what gets persisted and when — e.g. that the command-log menu's
   * `t` item persists visibility while `f` does not (pkg/gui/extras_panel.go:19-29 vs :40-46).
   */
  readonly onGeometryChange?: (state: PersistedUiState) => void
  /**
   * lazygit's background routines: `git fetch` every 60s and a working-tree refresh every 10s
   * (pkg/gui/background.go). Off by default here because the tests and one-shot embeddings that
   * build an app must not start timers; `src/main.ts` turns it on.
   */
  readonly background?: BackgroundOptions
  /** Injected review workspace seams for tests and embedded callers. */
  readonly reviewLoaders?: ReviewLoaders
}

export type BackgroundOptions = {
  readonly enabled: boolean
  readonly autoFetch?: boolean
  readonly autoRefresh?: boolean
  readonly autoDetectExternalChanges?: boolean
  readonly fetchIntervalMs?: number
  readonly refreshIntervalMs?: number
  readonly externalChangeIntervalMs?: number
}

export type App = {
  readonly controller: AppController
  readonly view: RootView | undefined
  readonly screenController: AppScreenController
  refresh(): Promise<void>
  saveUiState(): Promise<void>
  destroy(): void
}

/**
 * Reads the background-routine settings off the environment. githunk has no config file, so these
 * stand in for lazygit's `git.autoFetch`, `git.autoRefresh` and the `refresher.*` intervals.
 * `GITHUNK_AUTO_FETCH=0` is the switch someone on a metered or offline connection wants.
 */
export function backgroundOptionsFromEnv(env: Record<string, string | undefined> = process.env): BackgroundOptions {
  const flag = (name: string): boolean | undefined => {
    const value = env[name]
    if (value === undefined || value.length === 0) return undefined
    return value !== "0" && value.toLowerCase() !== "false"
  }
  const seconds = (name: string, fallback: number): number => {
    const value = Number(env[name])
    return Number.isFinite(value) && value > 0 ? value * 1000 : fallback
  }
  return {
    enabled: flag("GITHUNK_BACKGROUND") ?? true,
    autoFetch: flag("GITHUNK_AUTO_FETCH") ?? true,
    autoRefresh: flag("GITHUNK_AUTO_REFRESH") ?? true,
    autoDetectExternalChanges: flag("GITHUNK_DETECT_EXTERNAL_CHANGES") ?? true,
    fetchIntervalMs: seconds("GITHUNK_FETCH_INTERVAL", DEFAULT_FETCH_INTERVAL_MS),
    refreshIntervalMs: seconds("GITHUNK_REFRESH_INTERVAL", DEFAULT_REFRESH_INTERVAL_MS),
    externalChangeIntervalMs: seconds("GITHUNK_EXTERNAL_CHANGE_INTERVAL", DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS),
  }
}

export function createApp(options: CreateAppOptions): App {
  // `gh` is a network call, so it is wired only where a background routine will drive it: an app
  // built without background routines (tests, one-shot embeddings) never spawns it.
  const ghRunner = options.background?.enabled === true ? createGhRunner(options.repositoryRoot) : undefined
  // `printCommandLogHeader` runs at startup (pkg/gui/command_log_panel.go:70-85), before the gui's
  // first render; seeding here — before the controller's first `commandLogSnapshot()` — means the
  // controller's very first `AppModel` already carries it, in the headless path (no `renderer`)
  // as much as the full one, since the header is data rather than a timer or a subprocess.
  seedCommandLog(options.runner.log)
  const controller = new AppController({
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
    ...(ghRunner === undefined ? {} : { loadPullRequests: () => loadPullRequests(ghRunner) }),
  })
  const makeReviewController = (): ReviewWorkspaceController => {
    const stateStore = options.reviewLoaders?.stateStore ?? new ReviewStateStore(options.runner)
    const artifactStore = options.reviewLoaders?.artifactStore ?? new ReviewArtifactStore(options.runner)
    return new ReviewWorkspaceController({
      runner: options.runner,
      stateStore,
      artifactStore,
      ...(options.reviewLoaders?.loadDocument ? { loadDocument: options.reviewLoaders.loadDocument } : {}),
    })
  }
  const renderer = options.renderer
  if (renderer === undefined) {
    const screenController = new AppScreenController({
      repositoryController: controller,
      repositoryView: undefined,
      renderer: undefined,
      createReviewController: makeReviewController,
      createReviewView: (rc, onClose) => {
        return { destroy() {}, root: undefined } as unknown as ReviewWorkspace
      },
    })
    return {
      controller,
      view: undefined,
      screenController,
      refresh: () => controller.refresh(),
      saveUiState: async () => undefined,
      destroy: () => { screenController.destroy() },
    }
  }

  const uiStateStore = new UiStateStore(options.runner)
  let latestGeometry: PersistedUiState | undefined
  let persistedGeometryApplied = false
  const saveUiState = async (): Promise<void> => {
    if (latestGeometry !== undefined) await uiStateStore.save(latestGeometry)
  }
  let view!: RootView
  let screenController!: AppScreenController
  let refsWatcher!: RefsWatcher
  let indexWatcher: IndexWatcher | undefined
  let indexWatcherStart: Promise<void> | undefined
  let destroyed = false
  let refreshInFlight = false
  const backgroundOptions = options.background
  const ensureIndexWatcher = async (): Promise<void> => {
    if (destroyed || backgroundOptions?.enabled !== true || backgroundOptions.autoRefresh === false) return
    if (indexWatcherStart !== undefined) {
      await indexWatcherStart
      return
    }
    indexWatcherStart = (async () => {
      try {
        const result = await options.runner.run(["rev-parse", "--git-path", "index"], { readOnly: true })
        if (destroyed) return
        const rawIndexPath = result.stdout.trim()
        if (rawIndexPath.length === 0) return
        const indexPath = isAbsolute(rawIndexPath) ? rawIndexPath : resolve(options.runner.cwd, rawIndexPath)
        const watcher = new IndexWatcher({
          indexPath,
          onExternalChange: async () => {
            if (destroyed) return
            await controller.refreshFiles()
            if (!destroyed && (screenController?.shouldRenderRepository() ?? true)) view.update(controller.state)
          },
          isBusy: () => refreshInFlight || view.isMutating,
        })
        if (destroyed) {
          watcher.stop()
          return
        }
        watcher.start()
        indexWatcher = watcher
      } catch {
        // The periodic files refresh remains the fallback when Git or the filesystem cannot expose
        // the index path.
      }
    })()
    await indexWatcherStart
  }
  const editFile = options.onEditFile ?? (async (path: string, line?: number): Promise<void> => {
    const abs = absolutePath(options.repositoryRoot, path)
    const { cmd, suspend } = await resolveEditCommand([abs], { ...(line === undefined ? {} : { line }), runner: options.runner, cwd: options.repositoryRoot })
    const shouldSuspend = suspend && renderer !== undefined
    if (shouldSuspend) {
      try {
        const maybeSuspend = renderer as unknown as { suspend?: () => void }
        maybeSuspend.suspend?.()
      } catch {}
    }
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        cwd: options.repositoryRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env as Record<string, string>,
      })
      await proc.exited
      if (proc.exitCode !== 0 && proc.exitCode !== null) {
        throw new Error(`editor exited with code ${proc.exitCode}`)
      }
    } finally {
      if (shouldSuspend) {
        try {
          const maybeResume = renderer as unknown as { resume?: () => void }
          maybeResume.resume?.()
        } catch {}
        try {
          renderer.requestRender()
        } catch {}
      }
    }
    await controller.refresh()
    if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state)
    await refsWatcher.resync()
  })
  // Coalesced review generation refresh: at most one in-flight, one queued.
  let pendingReviewRefresh: Promise<void> | undefined
  let reviewRefreshQueued = false
  const scheduleCoalescedReviewRefresh = async (): Promise<void> => {
    if (!screenController || screenController.shouldRenderRepository()) return
    if (pendingReviewRefresh) {
      reviewRefreshQueued = true
      return
    }
    pendingReviewRefresh = (async () => {
      do {
        reviewRefreshQueued = false
        const cur = screenController.active
        if (cur.kind === "branch-review") {
          try {
            await cur.controller.refreshGeneration()
          } catch {}
        }
      } while (reviewRefreshQueued)
    })()
    try {
      await pendingReviewRefresh
    } finally {
      pendingReviewRefresh = undefined
    }
  }


  /**
   * Notices refs moving underneath the app. Declared ahead of the view because the view's
   * `onMutationSettled` re-seeds it; created unconditionally (it is inert until polled) so that
   * hook needs no branch.
   */
  refsWatcher = new RefsWatcher({
    snapshot: () => loadRefsSnapshot(options.runner),
    onExternalChange: async () => {
      const isReviewActive = !(screenController?.shouldRenderRepository() ?? true)
      if (isReviewActive) {
        // Hidden repository refresh without repainting the review screen
        void controller.refresh().catch(() => undefined)
        await scheduleCoalescedReviewRefresh()
        return
      }
      await controller.refresh()
      if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state)
    },
    isBusy: () => {
      const isReviewActive = !(screenController?.shouldRenderRepository() ?? true)
      if (isReviewActive) return false
      const isMutating = (view as unknown as { isMutating?: boolean } | undefined)?.isMutating === true
      return refreshInFlight || isMutating
    },
  })
  view = new RootView(renderer, controller.state, {
    onStageFile: async (path) => {
      try { await controller.stageFile(path) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onUnstageFile: async (path) => {
      try { await controller.unstageFile(path) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onDiscardFile: async (path, mode) => {
      try { await controller.discardFile(path, mode) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onToggleAllFiles: async () => {
      try { await controller.toggleAllFiles() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onScopeChange: async (scope) => {
      try { await controller.setWorkingTreeScope(scope) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onOpenBranchReview: async () => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await screenController.openBranchReview() } catch (error) {
        if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state)
        throw error
      }
    },
    onApplySelection: async (document, indexes, reverse) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.applySelection(document, indexes, { reverse, wholeFile: false }) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onDiscardSelection: async (document, indexes) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.discardSelection(document, indexes, { wholeFile: false }) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onSelectFile: (path) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      controller.selectFile(path)
      if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state)
    },
    loadCommitInspection: (oid) => controller.loadCommitInspection(oid),
    loadBranchCommits: options.loadBranchCommits ?? ((branch) => controller.loadBranchCommits(branch)),
    loadCommitFileInspection: (oid, path) => controller.loadCommitFileInspection(oid, path),
    loadTagInspection: (tag) => controller.loadTagInspection(tag),
    loadRefLogInspection: (target) => controller.loadRefLogInspection(target),
    onPreviewError: (error) => controller.recordInspectionError(error),
    onCommitMessage: async (message) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.commit(message) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onAmendMessage: async (message) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.amend(message) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCurrentCommitMessage: async () => {
      try { return await controller.currentCommitMessage() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onMarkFocusedFileReviewed: async (path) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.markFocusedFileReviewed(path) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onRefresh: async () => {
      try { await controller.refresh() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onSwitchLocalBranch: async (branch) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.switchLocalBranch(branch) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCreateBranch: async (startPoint, branchName, options) => {
      if (branchName === undefined) return
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.createBranch(branchName, startPoint, options) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCreateBranchWithAutostash: async (startPoint, branchName, options) => {
      if (branchName === undefined) return
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try { await controller.createBranchWithAutostash(branchName, startPoint, options) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onDeleteBranch: async (request) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try {
        if (request.mode === "local") {
          await controller.deleteBranch(request.branch, { force: request.force, confirmed: request.force })
        } else if (request.mode === "remote") {
          if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("remote branch deletion requires an upstream")
          await controller.deleteRemoteBranch(request.remote, request.remoteBranch)
        } else {
          if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("local and remote deletion requires an upstream")
          await controller.deleteLocalAndRemoteBranch(request.branch, request.remote, request.remoteBranch, { force: request.force, confirmed: request.force })
        }
      } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCheckBranchMerged: options.onCheckBranchMerged ?? ((branch, upstream) => controller.branchIsMerged(branch, upstream)),
    onDeleteBranchFromWorktree: async (path, action, request, forceWorktree) => {
      try { await controller.deleteBranchFromWorktree(path, action, request, forceWorktree) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onRenameBranch: async (branch, newName) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      if (newName === undefined) return
      try { await controller.renameBranch(branch, newName) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onFetchRemote: async (remote) => {
      try { await controller.fetchRemote(remote) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onFetch: async () => {
      try { await controller.fetch() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onPull: async () => {
      try { await controller.pull() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onPush: async () => {
      try { await controller.push() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCreateStash: async (message, includeUntracked) => {
      try { await controller.createStash(message, { includeUntracked }) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onApplyStash: async (ref) => {
      try { await controller.applyStash(ref) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onPopStash: async (ref) => {
      try { await controller.popStash(ref) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onDropStash: async (ref) => {
      try { await controller.dropStash(ref, { confirmed: true }) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onInspectStash: async (ref) => {
      try { await controller.inspectStash(ref) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onChooseUpstream: async (remote, branch) => {
      try { await controller.chooseUpstream(remote, branch) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCancelUpstream: async () => {
      try { await controller.cancelUpstreamChoice() } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onBrowseRemote: async (remote) => {
      try { await controller.browseRemote(remote) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onInspectBranch: async (branchRef) => {
      try { await controller.inspectBranch(branchRef) } finally { if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state) }
    },
    onCheckoutRemoteTracking: async (selection, confirmedMismatch) => {
      if (!(screenController?.shouldRenderRepository() ?? true)) return
      try {
        const result = await controller.checkoutRemoteTracking(selection, confirmedMismatch === true ? { confirmedMismatch: true } : undefined)
        if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state, { preserveRemoteCheckout: result?.kind === "mismatch" })
        return result
      } catch (error) {
        if (screenController?.shouldRenderRepository() ?? true) view.update(controller.state)
        throw error
      }
    },
    onFilterBranches: async () => undefined,
    onEditFile: async (path, line) => {
      // `LogAction(Tr.Actions.OpenFile)` (pkg/gui/controllers/helpers/files_helper.go:78). Logged
      // at the wiring, not inside the default `editFile` above, so it fires whether the default or
      // an injected `options.onEditFile` runs.
      options.runner.log.logAction(LOG_ACTIONS.openFile)
      await editFile(path, line)
    },
    onQuit: () => options.onQuit?.(),
    onGeometryChange: (state) => {
      latestGeometry = state
      options.onGeometryChange?.(state)
    },
    // Whatever githunk just did to the repository is now the baseline for ref polling. Index events
    // remain queued because the watcher cannot attribute a concurrent index write safely.
    onMutationSettled: () => { void refsWatcher.resync() },
  })

  screenController = new AppScreenController({
    repositoryController: controller,
    repositoryView: view,
    renderer,
    createReviewController: makeReviewController,
    createReviewView: (rc, onClose) => new ReviewWorkspace(renderer, rc, { onClose }),
  })

  /**
   * lazygit's background routines. The fetch is followed by a branch refresh, because that is
   * what changes when remote-tracking refs move — `PostFetchRefresh`
   * (pkg/gui/controllers/helpers/branches_helper.go, called from background.go:255-259) — and by a
   * pull-request refresh, which lazygit likewise re-runs from its remotes refresh
   * (refresh_helper.go:1552-1556).
   */
  const background = backgroundOptions?.enabled === true
    ? new BackgroundRefresher({
        fetch: async () => {
          // lazygit's background fetch is DontLog() while its foreground one is not
          // (pkg/commands/git_commands/sync.go:65-84).
          await controller.fetch(undefined, { background: true })
          await controller.refreshBranches()
          // Painted before the pull requests are asked for: `gh` is a network call, and lazygit
          // likewise lands its pull requests in their own pass whenever they happen to arrive
          // (refresh_helper.go:1845-1855) rather than holding the branch counts behind them.
          if (screenController.shouldRenderRepository()) view.update(controller.state)
          await controller.refreshPullRequests()
          if (screenController.shouldRenderRepository()) view.update(controller.state)
          await refsWatcher.resync()
        },
        refresh: async () => {
          await controller.refreshFiles()
          if (screenController.shouldRenderRepository()) view.update(controller.state)
        },
        detectExternalChanges: () => refsWatcher.check().then(() => undefined),
        ...(backgroundOptions.autoFetch === undefined ? {} : { autoFetch: backgroundOptions.autoFetch }),
        ...(backgroundOptions.autoRefresh === undefined ? {} : { autoRefresh: backgroundOptions.autoRefresh }),
        ...(backgroundOptions.autoDetectExternalChanges === undefined ? {} : { autoDetectExternalChanges: backgroundOptions.autoDetectExternalChanges }),
        ...(backgroundOptions.fetchIntervalMs === undefined ? {} : { fetchIntervalMs: backgroundOptions.fetchIntervalMs }),
        ...(backgroundOptions.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: backgroundOptions.refreshIntervalMs }),
        ...(backgroundOptions.externalChangeIntervalMs === undefined ? {} : { externalChangeIntervalMs: backgroundOptions.externalChangeIntervalMs }),
        // Everything the UI drives goes through `runUiMutation`, so this is lazygit's
        // `backgroundRefreshesPaused()` for githunk: no background git while the user's own runs.
        // Branch Review reconciliation must not be paused by busy/composer – it preserves draft.
        isBusy: () => {
          const isReviewActive = !(screenController?.shouldRenderRepository() ?? true)
          if (isReviewActive) return false
          const isMutating = (view as unknown as { isMutating?: boolean } | undefined)?.isMutating === true
          return refreshInFlight || isMutating
        },
        // A background fetch fails whenever the network does. The command log already carries the
        // failure; a banner would fight with whatever the user is reading.
        onError: () => undefined,
      })
    : undefined

  return {
    controller,
    view,
    screenController,
    refresh: async () => {
      if (!persistedGeometryApplied) {
        persistedGeometryApplied = true
        view.applyPersistedGeometry(await uiStateStore.load())
      }
      if (destroyed) return
      refreshInFlight = true
      try {
        await ensureIndexWatcher()
        await controller.refresh()
        if (screenController.shouldRenderRepository()) view.update(controller.state)
        await refsWatcher.resync()
      } finally {
        refreshInFlight = false
      }
      if (destroyed) return
      if (background !== undefined) {
        background.start()
        // lazygit fetches once immediately, because `goEvery` starts by waiting out the interval
        // (pkg/gui/background.go:135-137). Not awaited: the app is already usable.
        void controller.refreshPullRequests().then(() => { if (screenController.shouldRenderRepository()) view.update(controller.state) }).catch(() => undefined)
      }
    },
    saveUiState,
    destroy: () => {
      destroyed = true
      indexWatcher?.stop()
      background?.stop()
      screenController.destroy()
      // Geometry is a convenience: a failed final write must never mask a clean shutdown.
      void saveUiState().catch(() => undefined)
      view.destroy()
    },
  }
}

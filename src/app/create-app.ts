import type { CliRenderer } from "@opentui/core"
import { AppController, type CommitListLoader, type PullRequestListLoader } from "./controller"
import type { GitRunner } from "../git/runner"
import type { CommitSummary } from "../domain/commit"
import type { AppModel } from "../domain/repository"
import { createGhRunner, loadPullRequests } from "../git/github"
import { UiStateStore, type UiState as PersistedUiState } from "../ui/ui-state-store"
import { RootView } from "../ui/root-view"
import { BackgroundRefresher, DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS, DEFAULT_FETCH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS } from "./background"
import { RefsWatcher } from "./refs-watcher"
import { loadRefsSnapshot } from "../git/refs-snapshot"
import { absolutePath, resolveEditCommand } from "../git/editor"
import { isAbsolute, resolve } from "node:path"
import { runInteractiveProcess } from "../runtime/process"
import { IndexWatcher } from "./index-watcher"
import { LOG_ACTIONS } from "./log-actions"
import { seedCommandLog } from "./command-log-tips"
import { AppScreenController, type ReviewScreenView } from "./screen-controller"
import { ReviewWorkspaceController } from "../ui/review-workspace/controller"
import { createReactReviewView } from "../ui/review-workspace/react-review-host-lazy"
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
  /** Optional commit-history seam for embedded callers and tests. */
  readonly loadCommits?: CommitListLoader
  /** Optional pull-request loader; the default `gh` loader is enabled with background refresh. */
  readonly loadPullRequests?: PullRequestListLoader
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
  /** Test seam for the focus-trigger interval gate. */
  readonly now?: () => number
}

export type App = {
  readonly controller: AppController
  readonly view: RootView | undefined
  readonly screenController: AppScreenController
  refresh(): Promise<void>
  saveUiState(): Promise<void>
  destroy(): Promise<void>
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
    externalChangeIntervalMs: seconds("GITHUNK_EXTERNAL_CHANGE_INTERVAL", DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS)
  }
}

export function createApp(options: CreateAppOptions): App {
  // `gh` is a network call, so the default loader is wired only for background-enabled apps.
  // Tests and embedded callers can inject the same seam without starting background timers.
  const ghRunner = options.background?.enabled === true ? createGhRunner(options.repositoryRoot) : undefined
  const pullRequestLoader = options.loadPullRequests ?? (ghRunner === undefined ? undefined : () => loadPullRequests(ghRunner))
  // `printCommandLogHeader` runs at startup (pkg/gui/command_log_panel.go:70-85), before the gui's
  // first render; seeding here — before the controller's first `commandLogSnapshot()` — means the
  // controller's very first `AppModel` already carries it, in the headless path (no `renderer`)
  // as much as the full one, since the header is data rather than a timer or a subprocess.
  seedCommandLog(options.runner.log)
  let renderPullRequests: ((state: AppModel) => void) | undefined
  const controller = new AppController({
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
    ...(pullRequestLoader === undefined ? {} : { loadPullRequests: pullRequestLoader }),
    ...(options.loadCommits === undefined ? {} : { loadCommits: options.loadCommits }),
    onPullRequestsChanged: (state) => {
      renderPullRequests?.(state)
    }
  })
  const makeReviewController = (): ReviewWorkspaceController => {
    const stateStore = options.reviewLoaders?.stateStore ?? new ReviewStateStore(options.runner)
    const artifactStore = options.reviewLoaders?.artifactStore ?? new ReviewArtifactStore(options.runner)
    return new ReviewWorkspaceController({
      runner: options.runner,
      stateStore,
      artifactStore,
      ...(options.reviewLoaders?.loadDocument ? { loadDocument: options.reviewLoaders.loadDocument } : {})
    })
  }
  const renderer = options.renderer
  if (renderer === undefined) {
    const screenController = new AppScreenController({
      repositoryController: controller,
      repositoryView: undefined,
      renderer: undefined,
      createReviewController: makeReviewController,
      createReviewView: (): ReviewScreenView => ({
        root: { findDescendantById: () => undefined },
        destroy: () => undefined
      })
    })
    return {
      controller,
      view: undefined,
      screenController,
      refresh: () => controller.refresh(),
      saveUiState: async () => undefined,
      destroy: async () => {
        await screenController.destroy()
      }
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
            if (!destroyed) syncView()
          },
          isBusy: () => refreshInFlight || view.isMutating
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
  const editFile =
    options.onEditFile ??
    (async (path: string, line?: number): Promise<void> => {
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
        const exitCode = await runInteractiveProcess("sh", ["-c", cmd], {
          cwd: options.repositoryRoot,
          env: process.env
        })
        if (exitCode !== 0) {
          throw new Error(`editor exited with code ${exitCode}`)
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
      syncView()
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
  const shouldRender = (): boolean => screenController?.shouldRenderRepository() ?? true
  /** Repaints the repository screen from the controller's model, unless Branch Review owns the screen. */
  const syncView = (): void => {
    if (shouldRender()) view.update(controller.state)
  }
  /**
   * Runs a controller call and repaints however it settles. Every UI-driven controller call goes
   * through here so the `try { … } finally { view.update(controller.state) }` contract lives in
   * one place.
   */
  const ui =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args)
      } finally {
        syncView()
      }
    }
  /** `ui`, but a no-op while Branch Review owns the screen: the repository view cannot act then. */
  const repositoryUi =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      if (!shouldRender()) return
      await ui(fn)(...args)
    }
  const isBusy = (): boolean => {
    if (!shouldRender()) return false
    return refreshInFlight || view.isMutating
  }
  refsWatcher = new RefsWatcher({
    snapshot: () => loadRefsSnapshot(options.runner),
    onExternalChange: async () => {
      if (!shouldRender()) {
        // Hidden repository refresh without repainting the review screen
        void controller.refresh().catch(() => undefined)
        await scheduleCoalescedReviewRefresh()
        return
      }
      await controller.refresh()
      syncView()
    },
    isBusy
  })
  view = new RootView(renderer, controller.state, {
    ports: {
      commands: {
        onStageFile: repositoryUi((path) => controller.stageFile(path)),
        onStageFiles: repositoryUi((paths, stage) => (stage ? controller.stageFiles(paths) : controller.unstageFiles(paths))),
        onUnstageFile: repositoryUi((path) => controller.unstageFile(path)),
        onDiscardFile: repositoryUi((path, mode) => controller.discardFile(path, mode)),
        onDiscardFiles: repositoryUi((paths, mode) => controller.discardFiles(paths, mode)),
        onResetSubmodule: repositoryUi((submodule) => controller.resetSubmodule(submodule)),
        onToggleAllFiles: repositoryUi(() => controller.toggleAllFiles()),
        onScopeChange: repositoryUi((scope) => controller.setWorkingTreeScope(scope)),
        onOpenBranchReview: async () => {
          if (!shouldRender()) return
          try {
            await screenController.openBranchReview()
          } catch (error) {
            syncView()
            throw error
          }
        },
        onApplySelection: repositoryUi((document, indexes, reverse) => controller.applySelection(document, indexes, { reverse, wholeFile: false })),
        onDiscardSelection: repositoryUi((document, indexes) => controller.discardSelection(document, indexes, { wholeFile: false })),
        onSelectFile: (path) => {
          if (!shouldRender()) return
          controller.selectFile(path)
          syncView()
        },
        onExpandCommits: async () => {
          const expanded = await controller.expandCommits()
          // Preserve an open filter/search prompt across the reload: the default
          // update clears in-progress filtering (root-view `update`), which would
          // drop the session the expansion was opened for.
          if (expanded && shouldRender()) view.update(controller.state, { preserveFilterInput: true })
          return expanded
        },
        onMarkFocusedFileReviewed: repositoryUi((path) => controller.markFocusedFileReviewed(path)),
        onCommitMessage: repositoryUi((message) => controller.commit(message)),
        onAmendMessage: repositoryUi((message) => controller.amend(message)),
        onCreateBranch: repositoryUi(async (startPoint, branchName, createOptions) => {
          if (branchName === undefined) return
          await controller.createBranch(branchName, startPoint, createOptions)
        }),
        onCreateBranchWithAutostash: repositoryUi(async (startPoint, branchName, createOptions) => {
          if (branchName === undefined) return
          await controller.createBranchWithAutostash(branchName, startPoint, createOptions)
        }),
        onRefresh: ui(() => controller.refresh()),
        onSwitchLocalBranch: repositoryUi((branch) => controller.switchLocalBranch(branch)),
        onDeleteBranch: repositoryUi(async (request) => {
          if (request.mode === "local") {
            await controller.deleteBranch(request.branch, { force: request.force, confirmed: request.force })
          } else if (request.mode === "remote") {
            if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("remote branch deletion requires an upstream")
            await controller.deleteRemoteBranch(request.remote, request.remoteBranch)
          } else {
            if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("local and remote deletion requires an upstream")
            await controller.deleteLocalAndRemoteBranch(request.branch, request.remote, request.remoteBranch, { force: request.force, confirmed: request.force })
          }
        }),
        onDeleteBranches: repositoryUi((requests) => controller.deleteBranches(requests)),
        onDeleteBranchFromWorktree: ui((path, action, request, forceWorktree) => controller.deleteBranchFromWorktree(path, action, request, forceWorktree)),
        onFetchRemote: ui((remote) => controller.fetchRemote(remote)),
        onRenameBranch: repositoryUi(async (branch, newName) => {
          if (newName === undefined) return
          await controller.renameBranch(branch, newName)
        }),
        onFetch: ui(() => controller.fetch()),
        onPull: ui(() => controller.pull()),
        onPush: ui(async () => {
          await controller.push()
        }),
        onChooseUpstream: ui((remote, branch) => controller.chooseUpstream(remote, branch)),
        onCancelUpstream: ui(() => controller.cancelUpstreamChoice()),
        onPopStash: ui((ref) => controller.popStash(ref)),
        onCreateStash: ui((message, includeUntracked) => controller.createStash(message, { includeUntracked })),
        onApplyStash: ui((ref) => controller.applyStash(ref)),
        onDropStash: ui((ref) => controller.dropStash(ref, { confirmed: true })),
        onDropStashes: ui((refs) => controller.dropStashes(refs, { confirmed: true })),
        onInspectStash: ui((ref) => controller.inspectStash(ref)),
        onBrowseRemote: ui((remote) => controller.browseRemote(remote)),
        onInspectBranch: ui((branchRef) => controller.inspectBranch(branchRef)),
        onCheckoutRemoteTracking: async (selection, confirmedMismatch) => {
          if (!shouldRender()) return undefined
          try {
            const result = await controller.checkoutRemoteTracking(selection, confirmedMismatch === true ? { confirmedMismatch: true } : undefined)
            if (shouldRender()) view.update(controller.state, { preserveRemoteCheckout: result?.kind === "mismatch" })
            return result
          } catch (error) {
            syncView()
            throw error
          }
        },
        onEditFile: async (path, line) => {
          // `LogAction(Tr.Actions.OpenFile)` (pkg/gui/controllers/helpers/files_helper.go:78). Logged
          // at the wiring, not inside the default `editFile` above, so it fires whether the default or
          // an injected `options.onEditFile` runs.
          options.runner.log.logAction(LOG_ACTIONS.openFile)
          await editFile(path, line)
        }
      },
      queries: {
        loadCommitInspection: (oid) => controller.loadCommitInspection(oid),
        loadBranchCommits: options.loadBranchCommits ?? ((branch) => controller.loadBranchCommits(branch)),
        loadCommitFileInspection: (oid, path) => controller.loadCommitFileInspection(oid, path),
        loadTagInspection: (tag) => controller.loadTagInspection(tag),
        loadRefLogInspection: (target) => controller.loadRefLogInspection(target),
        onCurrentCommitMessage: ui(() => controller.currentCommitMessage()),
        onCheckBranchMerged: options.onCheckBranchMerged ?? ((branch, upstream) => controller.branchIsMerged(branch, upstream))
      },
      host: {
        onQuit: () => options.onQuit?.(),
        onGeometryChange: (state) => {
          latestGeometry = state
          options.onGeometryChange?.(state)
        },
        // Whatever githunk just did to the repository is now the baseline for ref polling. Index events
        // remain queued because the watcher cannot attribute a concurrent index write safely.
        onMutationSettled: () => {
          void refsWatcher.resync()
        },
        onPreviewError: (error) => controller.recordInspectionError(error),
        isBranchReviewActive: () => screenController?.active.kind === "branch-review"
      }
    }
  })

  screenController = new AppScreenController({
    repositoryController: controller,
    repositoryView: view,
    renderer,
    createReviewController: makeReviewController,
    createReviewView: (rc, onClose) => createReactReviewView(renderer, rc, onClose)
  })
  renderPullRequests = (state) => {
    if (destroyed || !screenController.shouldRenderRepository()) return
    view.update(state)
  }

  /**
   * lazygit's background routines. A fetch uses AppController.refresh()'s full-refresh path, so
   * local refs and pull requests begin together and the local model paints before the auxiliary
   * GitHub query completes.
   */
  const background =
    backgroundOptions?.enabled === true
      ? new BackgroundRefresher({
          fetch: async () => {
            // lazygit's background fetch is DontLog() while its foreground one is not
            // (pkg/commands/git_commands/sync.go:65-84).
            await controller.fetch(undefined, { background: true })
            syncView()
            await refsWatcher.resync()
          },
          refresh: async () => {
            await controller.refreshFiles()
            syncView()
          },
          detectExternalChanges: () => refsWatcher.check().then(() => undefined),
          ...(backgroundOptions.autoFetch === undefined ? {} : { autoFetch: backgroundOptions.autoFetch }),
          ...(backgroundOptions.autoRefresh === undefined ? {} : { autoRefresh: backgroundOptions.autoRefresh }),
          ...(backgroundOptions.autoDetectExternalChanges === undefined ? {} : { autoDetectExternalChanges: backgroundOptions.autoDetectExternalChanges }),
          ...(backgroundOptions.fetchIntervalMs === undefined ? {} : { fetchIntervalMs: backgroundOptions.fetchIntervalMs }),
          ...(backgroundOptions.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: backgroundOptions.refreshIntervalMs }),
          ...(backgroundOptions.externalChangeIntervalMs === undefined ? {} : { externalChangeIntervalMs: backgroundOptions.externalChangeIntervalMs }),
          ...(backgroundOptions.now === undefined ? {} : { now: backgroundOptions.now }),
          // Everything the UI drives goes through `runUiMutation`, so this is lazygit's
          // `backgroundRefreshesPaused()` for githunk: no background git while the user's own runs.
          // Branch Review reconciliation must not be paused by busy/composer – it preserves draft.
          isBusy,
          // A background fetch fails whenever the network does. The command log already carries the
          // failure; a banner would fight with whatever the user is reading.
          onError: () => undefined
        })
      : undefined

  /**
   * lazygit triggers an overdue background fetch when a repository becomes active again
   * (`pkg/gui/gui.go:332-339`); OpenTUI's terminal focus event is the equivalent signal when the
   * user returns to this TUI.
   */
  const onTerminalFocus = (): void => {
    background?.triggerFetchIfDue()
  }
  if (background !== undefined) renderer.on("focus", onTerminalFocus)

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
        syncView()
        await refsWatcher.resync()
      } finally {
        refreshInFlight = false
      }
      if (destroyed) return
      if (background !== undefined) {
        background.start()
      }
    },
    saveUiState,
    destroy: async () => {
      destroyed = true
      indexWatcher?.stop()
      if (background !== undefined) {
        renderer.off("focus", onTerminalFocus)
        background.stop()
      }
      await screenController.destroy()
      // Geometry is a convenience: a failed final write must never mask a clean shutdown.
      await saveUiState().catch(() => undefined)
      view.destroy()
    }
  }
}

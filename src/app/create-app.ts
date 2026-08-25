import type { CliRenderer } from "@opentui/core"
import { AppController } from "./controller"
import type { GitRunner } from "../git/runner"
import { createGhRunner, loadPullRequests } from "../git/github"
import { UiStateStore, type UiState as PersistedUiState } from "../ui/ui-state-store"
import { RootView } from "../ui/root-view"
import { BackgroundRefresher, DEFAULT_FETCH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS } from "./background"

export type CreateAppOptions = {
  readonly repositoryRoot: string
  readonly runner: GitRunner
  readonly renderer?: CliRenderer
  readonly onQuit?: () => void
  /**
   * lazygit's background routines: `git fetch` every 60s and a working-tree refresh every 10s
   * (pkg/gui/background.go). Off by default here because the tests and one-shot embeddings that
   * build an app must not start timers; `src/main.ts` turns it on.
   */
  readonly background?: BackgroundOptions
}

export type BackgroundOptions = {
  readonly enabled: boolean
  readonly autoFetch?: boolean
  readonly autoRefresh?: boolean
  readonly fetchIntervalMs?: number
  readonly refreshIntervalMs?: number
}

export type App = {
  readonly controller: AppController
  readonly view: RootView | undefined
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
    fetchIntervalMs: seconds("GITHUNK_FETCH_INTERVAL", DEFAULT_FETCH_INTERVAL_MS),
    refreshIntervalMs: seconds("GITHUNK_REFRESH_INTERVAL", DEFAULT_REFRESH_INTERVAL_MS),
  }
}

export function createApp(options: CreateAppOptions): App {
  // `gh` is a network call, so it is wired only where a background routine will drive it: an app
  // built without background routines (tests, one-shot embeddings) never spawns it.
  const ghRunner = options.background?.enabled === true ? createGhRunner(options.repositoryRoot, options.runner.log) : undefined
  const controller = new AppController({
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
    ...(ghRunner === undefined ? {} : { loadPullRequests: () => loadPullRequests(ghRunner) }),
  })
  const renderer = options.renderer
  if (renderer === undefined) {
    return {
      controller,
      view: undefined,
      refresh: () => controller.refresh(),
      saveUiState: async () => undefined,
      destroy: () => undefined,
    }
  }

  const uiStateStore = new UiStateStore(options.runner)
  let latestGeometry: PersistedUiState | undefined
  let persistedGeometryApplied = false
  const saveUiState = async (): Promise<void> => {
    if (latestGeometry !== undefined) await uiStateStore.save(latestGeometry)
  }
  let view: RootView
  view = new RootView(renderer, controller.state, {
    onStageFile: async (path) => {
      try { await controller.stageFile(path) } finally { view.update(controller.state) }
    },
    onUnstageFile: async (path) => {
      try { await controller.unstageFile(path) } finally { view.update(controller.state) }
    },
    onDiscardFile: async (path, untracked) => {
      try { await controller.discardFile(path, untracked) } finally { view.update(controller.state) }
    },
    onToggleAllFiles: async () => {
      try { await controller.toggleAllFiles() } finally { view.update(controller.state) }
    },
    onModeChange: async (mode) => {
      try { await controller.switchMode(mode) } finally { view.update(controller.state) }
    },
    onChooseBase: async (baseRef) => {
      try { await controller.chooseBase(baseRef) } finally { view.update(controller.state) }
    },
    onCancelBase: async () => {
      try { await controller.cancelBasePicker() } finally { view.update(controller.state) }
    },
    onApplySelection: async (document, indexes, reverse) => {
      try { await controller.applySelection(document, indexes, { reverse, wholeFile: false }) } finally { view.update(controller.state) }
    },
    onDiscardSelection: async (document, indexes) => {
      try { await controller.discardSelection(document, indexes, { wholeFile: false }) } finally { view.update(controller.state) }
    },
    onSelectFile: (path) => {
      controller.selectFile(path)
      view.update(controller.state)
    },
    loadCommitInspection: (oid) => controller.loadCommitInspection(oid),
    loadCommitFileInspection: (oid, path) => controller.loadCommitFileInspection(oid, path),
    loadTagInspection: (tag) => controller.loadTagInspection(tag),
    loadRefLogInspection: (target) => controller.loadRefLogInspection(target),
    onPreviewError: (error) => controller.recordInspectionError(error),
    onCommitMessage: async (message) => {
      try { await controller.commit(message) } finally { view.update(controller.state) }
    },
    onAmendMessage: async (message) => {
      try { await controller.amend(message) } finally { view.update(controller.state) }
    },
    onCurrentCommitMessage: async () => {
      try { return await controller.currentCommitMessage() } finally { view.update(controller.state) }
    },
    onMarkFocusedFileReviewed: async (path) => {
      try { await controller.markFocusedFileReviewed(path) } finally { view.update(controller.state) }
    },
    onRefresh: async () => {
      try { await controller.refresh() } finally { view.update(controller.state) }
    },
    onSwitchLocalBranch: async (branch) => {
      try { await controller.switchLocalBranch(branch) } finally { view.update(controller.state) }
    },
    onCreateBranch: async (startPoint, branchName) => {
      if (branchName === undefined) return
      try { await controller.createBranch(branchName, startPoint) } finally { view.update(controller.state) }
    },
    onDeleteBranch: async (branch, force) => {
      try { await controller.deleteBranch(branch, { force, confirmed: force }) } finally { view.update(controller.state) }
    },
    onRenameBranch: async (branch, newName) => {
      if (newName === undefined) return
      try { await controller.renameBranch(branch, newName) } finally { view.update(controller.state) }
    },
    onFetchRemote: async (remote) => {
      try { await controller.fetchRemote(remote) } finally { view.update(controller.state) }
    },
    onFetch: async () => {
      try { await controller.fetch() } finally { view.update(controller.state) }
    },
    onPull: async () => {
      try { await controller.pull() } finally { view.update(controller.state) }
    },
    onPush: async () => {
      try { await controller.push() } finally { view.update(controller.state) }
    },
    onCreateStash: async (message, includeUntracked) => {
      try { await controller.createStash(message, { includeUntracked }) } finally { view.update(controller.state) }
    },
    onApplyStash: async (ref) => {
      try { await controller.applyStash(ref) } finally { view.update(controller.state) }
    },
    onPopStash: async (ref) => {
      try { await controller.popStash(ref) } finally { view.update(controller.state) }
    },
    onDropStash: async (ref) => {
      try { await controller.dropStash(ref, { confirmed: true }) } finally { view.update(controller.state) }
    },
    onInspectStash: async (ref) => {
      try { await controller.inspectStash(ref) } finally { view.update(controller.state) }
    },
    onChooseUpstream: async (remote, branch) => {
      try { await controller.chooseUpstream(remote, branch) } finally { view.update(controller.state) }
    },
    onCancelUpstream: async () => {
      try { await controller.cancelUpstreamChoice() } finally { view.update(controller.state) }
    },
    onBrowseRemote: async (remote) => {
      try { await controller.browseRemote(remote) } finally { view.update(controller.state) }
    },
    onInspectBranch: async (branchRef) => {
      try { await controller.inspectBranch(branchRef) } finally { view.update(controller.state) }
    },
    onCheckoutRemoteTracking: async (selection, confirmedMismatch) => {
      try {
        const result = await controller.checkoutRemoteTracking(selection, confirmedMismatch === true ? { confirmedMismatch: true } : undefined)
        view.update(controller.state, { preserveRemoteCheckout: result?.kind === "mismatch" })
        return result
      } catch (error) {
        view.update(controller.state)
        throw error
      }
    },
    onFilterBranches: async () => undefined,
    onQuit: () => options.onQuit?.(),
    onGeometryChange: (state) => { latestGeometry = state },
  })

  const backgroundOptions = options.background
  /**
   * lazygit's two background routines. The fetch is followed by a branch refresh, because that is
   * what changes when remote-tracking refs move — `PostFetchRefresh`
   * (pkg/gui/controllers/helpers/branches_helper.go, called from background.go:255-259) — and by a
   * pull-request refresh, which lazygit likewise re-runs from its remotes refresh
   * (refresh_helper.go:1552-1556).
   */
  const background = backgroundOptions?.enabled === true
    ? new BackgroundRefresher({
        fetch: async () => {
          await controller.fetch()
          await controller.refreshBranches()
          await controller.refreshPullRequests()
          view.update(controller.state)
        },
        refresh: async () => {
          await controller.refreshFiles()
          view.update(controller.state)
        },
        ...(backgroundOptions.autoFetch === undefined ? {} : { autoFetch: backgroundOptions.autoFetch }),
        ...(backgroundOptions.autoRefresh === undefined ? {} : { autoRefresh: backgroundOptions.autoRefresh }),
        ...(backgroundOptions.fetchIntervalMs === undefined ? {} : { fetchIntervalMs: backgroundOptions.fetchIntervalMs }),
        ...(backgroundOptions.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: backgroundOptions.refreshIntervalMs }),
        // Everything the UI drives goes through `runUiMutation`, so this is lazygit's
        // `backgroundRefreshesPaused()` for githunk: no background git while the user's own runs.
        isBusy: () => view.isMutating,
        // A background fetch fails whenever the network does. The command log already carries the
        // failure; a banner would fight with whatever the user is reading.
        onError: () => undefined,
      })
    : undefined

  return {
    controller,
    view,
    refresh: async () => {
      if (!persistedGeometryApplied) {
        persistedGeometryApplied = true
        view.applyPersistedGeometry(await uiStateStore.load())
      }
      await controller.refresh()
      view.update(controller.state)
      if (background !== undefined) {
        background.start()
        // lazygit fetches once immediately, because `goEvery` starts by waiting out the interval
        // (pkg/gui/background.go:135-137). Not awaited: the app is already usable.
        void controller.refreshPullRequests().then(() => view.update(controller.state)).catch(() => undefined)
      }
    },
    saveUiState,
    destroy: () => {
      background?.stop()
      // Geometry is a convenience: a failed final write must never mask a clean shutdown.
      void saveUiState().catch(() => undefined)
      view.destroy()
    },
  }
}

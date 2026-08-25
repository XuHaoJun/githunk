import {
  BoxRenderable,
  StyledText,
  cyan,
  dim,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"
import type { AppModel } from "../app/model"
import type { CommitDetails } from "../domain/commit"
import type { TagSummary } from "../domain/tag"
import {
  DEFAULT_LOG_HEIGHT,
  DEFAULT_SIDE_PANEL_RATIO,
  SIDE_WINDOWS,
  computeLayout,
  heightOf,
  logHeightForMouseY,
  nextScreenMode,
  previousScreenMode,
  ratioForMouseX,
  widthOf,
  type LayoutGeometry,
  type LayoutRequest,
  type ScreenMode,
  type SideWindow,
  type WindowName,
} from "./layout"
import { FocusManager, FOCUS_IDS, type FocusId } from "./focus"
import { createBranchesPane } from "./panes/branches-pane"
import { localBranchRows } from "./panes/branches-pane"
import { remoteRows, remoteBranchRows } from "./panes/remotes-pane"
import { tagRows } from "./panes/tags-pane"
import { commitsCursorIndex as readCommitsCursorIndex, createCommitsPane, getSelectedCommit, moveCommitsCursor, updateCommitsPane } from "./panes/commits-pane"
import { createCommandLogPane, type CommandLogPaneHandle } from "./panes/command-log-pane"
import { createFilesPane, filesPaneCommitAvailable, updateFilesPane } from "./panes/files-pane"
import { createMainPane, changeLineIndexes, getMainCursorTarget, getMainDocument, installMainContent as installMainPaneContent, mainActionAvailability, mainCursorTargetLine, mainPaneCommitAvailable, moveMainCursor, scrollMainPane, setMainCursorTarget, setMainLoading, type MainPaneContent } from "./panes/main-pane"
import { commitFileRows } from "./panes/commit-files-pane"
import { createStashPane, moveStashCursor, selectedStashEntry, selectedStashItem, stashCursorIndex, updateStashPane } from "./panes/stash-pane"
import { createStatusPane, updateStatusPane } from "./panes/status-pane"
import { paneScrollbar, scrollYToReveal, syncVerticalScrollbar, type PaneHandle } from "./panes/common"
import { copySelection, selectionFromRenderable } from "../domain/diff/selection"
import type { CopyMode, DiffDocument } from "../domain/diff/document"
import { parseDiff } from "../domain/diff/parse"
import { ClipboardService, formatCopyResult, type ClipboardPort } from "./clipboard"
import { discardConfirmation } from "./confirm-dialog"
import { branchDeleteConfirmation, remoteTrackingMismatchConfirmation } from "./branch-dialogs"
import { COPY_MENU_ITEMS } from "./copy-menu"
import type { CheckoutRemoteTrackingResult, RemoteBranchSelection } from "../git/branches"
import { CommitDialog, commitDialogKey, renderCommitDialog } from "./commit-dialog"
import { FilterInput } from "./filter-input"
import { normalizeKey } from "./keymap"
import { createHintsBar, reviewStatusText, type HintsBarHandle } from "./hints-bar"
import { createKeybindingMenu, type KeybindingMenuHandle } from "./keybinding-menu"
import { createSplitter, type SplitterAxis, type SplitterHandle } from "./splitter"
import { type UiState as PersistedUiState } from "./ui-state-store"
import { createRegistry, type Action, type MenuEntry, type UiState } from "./bindings"
import { createPanelState, cyclePanelTab, enterPanelChild, leavePanelChild, type PanelState } from "./panel-state"
import { createListState, listRowAtPoint, moveListSelection, renderListRows, selectListRow, setListRows, type ListState } from "./list-view"
import { MainPreviewGate } from "./main-preview"

const PANE_TITLES: Readonly<Record<FocusId, string>> = {
  main: "Main", status: "Review", files: "Files",
  branches: "Branches", commits: "Commits", stash: "Stash",
  "command-log": "Command Log",
}

function paneTitleFor(focus: FocusId): string {
  return PANE_TITLES[focus]
}
export type RootViewOptions = {
  readonly sidePanelRatio?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly onGeometryChange?: (state: PersistedUiState) => void
  readonly onStageFile?: (path: string) => Promise<void>
  readonly onUnstageFile?: (path: string) => Promise<void>
  readonly onDiscardFile?: (path: string, untracked: boolean) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onModeChange?: (mode: "working-tree" | "branch") => Promise<void>
  readonly onChooseBase?: (baseRef: string) => Promise<void>
  readonly onCancelBase?: () => Promise<void>
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile?: (path: string) => void
  readonly loadCommitInspection?: (oid: string) => Promise<CommitDetails>
  readonly loadCommitFileInspection?: (oid: string, path: string) => Promise<DiffDocument>
  readonly loadTagInspection?: (tag: TagSummary) => Promise<import("../domain/tag").TagPreview>
  readonly onPreviewError?: (error: unknown) => void
  readonly onMarkFocusedFileReviewed?: (path?: string) => Promise<void>
  readonly onCommitMessage?: (message: string) => Promise<void>
  readonly onAmendMessage?: (message: string) => Promise<void>
  readonly onCurrentCommitMessage?: () => Promise<string>
  readonly onRefresh?: () => Promise<void>
  readonly onSwitchLocalBranch?: (branch: string) => Promise<void>
  readonly onCreateBranch?: (startPoint?: string, branchName?: string) => Promise<void>
  readonly onDeleteBranch?: (branch: string, force: boolean) => Promise<void>
  readonly onFetchRemote?: (remote: string) => Promise<void>
  readonly onRenameBranch?: (branch: string, newName?: string) => Promise<void>
  readonly onFetch?: () => Promise<void>
  readonly onPull?: () => Promise<void>
  readonly onPush?: () => Promise<void>
  readonly onChooseUpstream?: (remote: string, branch: string) => Promise<void>
  readonly onCancelUpstream?: () => Promise<void>
  readonly onPopStash?: (ref: string) => Promise<void>
  readonly onCreateStash?: (message: string, includeUntracked: boolean) => Promise<void>
  readonly onApplyStash?: (ref: string) => Promise<void>
  readonly onDropStash?: (ref: string) => Promise<void>
  readonly onInspectStash?: (ref: string) => Promise<void>
  readonly onBrowseRemote?: (remote: string) => Promise<void>
  readonly onInspectBranch?: (branch: string) => Promise<void>
  readonly onCheckoutRemoteTracking?: (selection: RemoteBranchSelection, confirmedMismatch?: boolean) => Promise<CheckoutRemoteTrackingResult | undefined>
  readonly onFilterBranches?: () => Promise<void>
  readonly onQuit?: () => void
}

/** Renders a `ConfirmationRequest`'s `confirmKey`/`cancelKey` (e.g. "enter") for display (e.g. "Enter"). */
function capitalizeKeyName(key: string): string {
  return key.length === 0 ? key : key[0]!.toUpperCase() + key.slice(1)
}

const DOUBLE_CLICK_MS = 400

export type GestureOwner =
  | { readonly kind: "vertical-splitter" }
  | { readonly kind: "horizontal-splitter" }
  | { readonly kind: "scrollbar"; readonly paneId: FocusId }
  | { readonly kind: "main-selection" }


export class RootView {
  readonly renderer: CliRenderer
  readonly root: BoxRenderable
  readonly focusManager = new FocusManager()
  geometry: LayoutGeometry
  /** lazygit parity: + / _ cycle how much of the terminal the two regions claim. */
  screenMode: ScreenMode = "normal"
  sidePanelRatio = DEFAULT_SIDE_PANEL_RATIO
  private logHeight: number
  private focusBeforeCollapse: FocusId | undefined
  private lastSplitterPress: { readonly axis: "vertical" | "horizontal"; readonly x: number; readonly y: number; readonly at: number } | undefined
  private activeSplitterDrag: SplitterAxis | undefined
  gestureOwner: GestureOwner | undefined
  private pendingClick: { readonly viewId: string; readonly stableId: string; readonly x: number; readonly y: number; readonly at: number } | undefined
  private model: AppModel
  private readonly panes: Record<Exclude<FocusId, "command-log">, PaneHandle>
  private readonly commandLog: CommandLogPaneHandle
  private readonly clipboard: ClipboardService
  private readonly verticalSplitter: SplitterHandle
  private readonly horizontalSplitter: SplitterHandle
  private readonly hintsBar: HintsBarHandle
  private readonly keybindingMenu: KeybindingMenuHandle
  private readonly onStageFile: ((path: string) => Promise<void>) | undefined
  private readonly onUnstageFile: ((path: string) => Promise<void>) | undefined
  private readonly onDiscardFile: ((path: string, untracked: boolean) => Promise<void>) | undefined
  private readonly onToggleAllFiles: (() => Promise<void>) | undefined
  private readonly onModeChange: ((mode: "working-tree" | "branch") => Promise<void>) | undefined
  private readonly onChooseBase: ((baseRef: string) => Promise<void>) | undefined
  private readonly onCancelBase: (() => Promise<void>) | undefined
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private basePickerIndex = 0
  private readonly onSelectFile: ((path: string) => void) | undefined
  private readonly loadCommitInspection: ((oid: string) => Promise<CommitDetails>) | undefined
  private readonly loadCommitFileInspection: ((oid: string, path: string) => Promise<DiffDocument>) | undefined
  private readonly loadTagInspection: ((tag: TagSummary) => Promise<import("../domain/tag").TagPreview>) | undefined
  private readonly onPreviewError: ((error: unknown) => void) | undefined
  private readonly onCommitMessage: ((message: string) => Promise<void>) | undefined
  private readonly onAmendMessage: ((message: string) => Promise<void>) | undefined
  private readonly onCurrentCommitMessage: (() => Promise<string>) | undefined
  private commitDialog: CommitDialog | undefined
  private readonly onMarkFocusedFileReviewed: ((path?: string) => Promise<void>) | undefined
  private readonly onRefresh: (() => Promise<void>) | undefined
  private readonly onSwitchLocalBranch: ((branch: string) => Promise<void>) | undefined
  private readonly onCreateBranch: ((startPoint?: string, branchName?: string) => Promise<void>) | undefined
  private readonly onDeleteBranch: ((branch: string, force: boolean) => Promise<void>) | undefined
  private readonly onFetchRemote: ((remote: string) => Promise<void>) | undefined
  private readonly onRenameBranch: ((branch: string, newName?: string) => Promise<void>) | undefined
  private readonly onFetch: (() => Promise<void>) | undefined
  private readonly onPull: (() => Promise<void>) | undefined
  private readonly onPush: (() => Promise<void>) | undefined
  private readonly onChooseUpstream: ((remote: string, branch: string) => Promise<void>) | undefined
  private readonly onCancelUpstream: (() => Promise<void>) | undefined
  private readonly onCreateStash: ((message: string, includeUntracked: boolean) => Promise<void>) | undefined
  private readonly onApplyStash: ((ref: string) => Promise<void>) | undefined
  private readonly onPopStash: ((ref: string) => Promise<void>) | undefined
  private readonly onDropStash: ((ref: string) => Promise<void>) | undefined
  private readonly onInspectStash: ((ref: string) => Promise<void>) | undefined
  private readonly onBrowseRemote: ((remote: string) => Promise<void>) | undefined
  private readonly onInspectBranch: ((branch: string) => Promise<void>) | undefined
  private readonly onCheckoutRemoteTracking: ((selection: RemoteBranchSelection, confirmedMismatch?: boolean) => Promise<CheckoutRemoteTrackingResult | undefined>) | undefined
  private readonly onFilterBranches: (() => Promise<void>) | undefined
  private copyMenuOpen = false
  private menuOpen = false
  private upstreamCursorIndex = 0
  private stashIncludeUntracked = false
  private pendingDiscardPaths: readonly string[] = []
  private discardPending = false
  private pendingStashDrop: { readonly oid: string; readonly ref: string } | undefined
  private pendingFileDiscard: { readonly path: string; readonly untracked: boolean } | undefined
  private branchDialogContext: { readonly mode: "branch-create"; readonly startPoint?: string } | { readonly mode: "branch-rename"; readonly branch: string } | undefined
  private mutationInFlight = false
  private fileCursorIndex = 0
  private pendingBranchDelete: { readonly branch: string; readonly force: boolean } | undefined
  private pendingRemoteMismatch: { readonly selection: RemoteBranchSelection; readonly message: string } | undefined
  private remoteCheckoutGeneration = 0
  private remoteCheckoutInFlight = false
  private branchFilter = ""
  private branchFilterActive = false
  branchesPanel: PanelState<"branches" | "remotes" | "tags", { kind: "remote-branches"; remote: string }>
  commitsPanel: PanelState<"commits", { kind: "commit-files"; oid: string; details: CommitDetails }>
  private mainGate!: MainPreviewGate
  private installedMainContent: MainPaneContent | undefined
  private mainLoading = false
  private previewInflight: Promise<void> = Promise.resolve()
  private readonly registry = createRegistry()
  private readonly onQuit: (() => void) | undefined
  private readonly onGeometryChange: ((state: PersistedUiState) => void) | undefined
  private readonly filterInput = new FilterInput()
  private readonly handleResize: () => void
  private readonly handleKey: (key: KeyEvent) => void
  private destroyed = false

  constructor(renderer: CliRenderer, model: AppModel, options: RootViewOptions = {}) {
    const clipboardPort: ClipboardPort = {
      isOsc52Supported: () => renderer.isOsc52Supported(),
      copyToClipboardOSC52: (text) => renderer.copyToClipboardOSC52(text),
    }
    this.clipboard = new ClipboardService(clipboardPort)
    this.onStageFile = options.onStageFile
    this.onApplyStash = options.onApplyStash
    this.onModeChange = options.onModeChange
    this.onQuit = options.onQuit
    this.onGeometryChange = options.onGeometryChange
    this.onChooseBase = options.onChooseBase
    this.onCancelBase = options.onCancelBase
    this.onUnstageFile = options.onUnstageFile
    this.onDiscardFile = options.onDiscardFile
    this.onToggleAllFiles = options.onToggleAllFiles
    this.onApplySelection = options.onApplySelection
    this.onDiscardSelection = options.onDiscardSelection
    this.onSelectFile = options.onSelectFile
    this.onRefresh = options.onRefresh
    this.onFetchRemote = options.onFetchRemote
    this.onFetch = options.onFetch
    this.onPull = options.onPull
    this.onCreateStash = options.onCreateStash
    this.onPush = options.onPush
    this.onChooseUpstream = options.onChooseUpstream
    this.onCancelUpstream = options.onCancelUpstream
    this.onPopStash = options.onPopStash
    this.onDropStash = options.onDropStash
    this.onInspectStash = options.onInspectStash
    this.onSwitchLocalBranch = options.onSwitchLocalBranch
    this.onCreateBranch = options.onCreateBranch
    this.onDeleteBranch = options.onDeleteBranch
    this.onRenameBranch = options.onRenameBranch
    this.onInspectBranch = options.onInspectBranch
    this.onBrowseRemote = options.onBrowseRemote
    this.onCheckoutRemoteTracking = options.onCheckoutRemoteTracking
    this.onFilterBranches = options.onFilterBranches
    this.loadCommitInspection = options.loadCommitInspection
    this.loadCommitFileInspection = options.loadCommitFileInspection
    this.loadTagInspection = options.loadTagInspection
    this.onPreviewError = options.onPreviewError
    this.onCommitMessage = options.onCommitMessage
    this.onAmendMessage = options.onAmendMessage
    this.onCurrentCommitMessage = options.onCurrentCommitMessage
    this.onMarkFocusedFileReviewed = options.onMarkFocusedFileReviewed
    this.renderer = renderer
    this.model = model
    this.focusManager.logVisible = options.logVisible ?? false
    this.logHeight = options.logHeight ?? DEFAULT_LOG_HEIGHT
    if (options.sidePanelRatio !== undefined) this.sidePanelRatio = options.sidePanelRatio
    this.geometry = computeLayout(
      { width: renderer.terminalWidth, height: renderer.terminalHeight },
      this.layoutOptions(),
    )
    this.root = new BoxRenderable(renderer, {
      id: "githunk-root",
      width: "100%",
      height: "100%",
      position: "relative",
      overflow: "hidden",
    })

    this.panes = {
      main: createMainPane(renderer, model),
      status: createStatusPane(renderer, model),
      files: createFilesPane(renderer, model),
      branches: createBranchesPane(renderer, model),
      commits: createCommitsPane(renderer, model),
      stash: createStashPane(renderer, model),
    }
    // Initialize PanelState for window 3 tabs (branches|remotes|tags) with transient RemoteBranches child
    {
      const branchesRows = localBranchRows(model, this.branchFilter)
      const remotesRowsData = remoteRows(model, this.branchFilter)
      const tagsRowsData = tagRows(model, this.branchFilter)
      this.branchesPanel = createPanelState(
        ["branches", "remotes", "tags"] as const,
        "branches",
        {
          branches: createListState(branchesRows),
          remotes: createListState(remotesRowsData),
          tags: createListState(tagsRowsData),
        },
      )
      this.renderBranchesPane()
    }
    // Initialize PanelState for window 4 (commits + transient commit-files)
    {
      const commits = model.commits ?? []
      const rows = commits.map((c) => {
        const id = c.oid
        // minimal columns for ListState; rendering handled by commits-pane via updateCommitsPane
        return { id, columns: [{ text: c.subject, priority: 2 }] }
      })
      this.commitsPanel = createPanelState(["commits"] as const, "commits", { commits: createListState(rows) })
      this.renderCommitsPane()
    }
    this.mainGate = new MainPreviewGate({
      install: (content) => {
        this.installedMainContent = content
        installMainPaneContent(this.panes.main, content, this.geometry.tooSmall)
        this.root.requestRender()
      },
      setLoading: (loading) => {
        this.mainLoading = loading
        setMainLoading(this.panes.main, loading, this.geometry.tooSmall)
        this.root.requestRender()
      },
      reportError: (error) => {
        this.onPreviewError?.(error)
        this.mainLoading = false
        setMainLoading(this.panes.main, false, this.geometry.tooSmall)
        this.root.requestRender()
      },
    })
    this.installInitialMainContent(model)
    this.commandLog = createCommandLogPane(renderer, model.commandLog)
    this.verticalSplitter = createSplitter(renderer, "vertical", "vertical-splitter")
    this.horizontalSplitter = createSplitter(renderer, "horizontal", "horizontal-splitter")
    for (const id of FOCUS_IDS) this.root.add(this.panes[id].box)
    this.root.add(this.commandLog.box)
    this.root.add(this.verticalSplitter.box)
    this.root.add(this.horizontalSplitter.box)
    this.hintsBar = createHintsBar(renderer)
    this.keybindingMenu = createKeybindingMenu(renderer)
    this.root.add(this.hintsBar.hints)
    this.root.add(this.hintsBar.status)
    this.root.add(this.keybindingMenu.box)
    renderer.root.add(this.root)

    this.focusManager.onChange = (focus, _logVisible) => {
      this.pendingClick = undefined
      this.cancelGesture()
      this.clearDiscardState()
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.pendingStashDrop = undefined
      this.panes.stash.box.bottomTitle = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.filterInput.close()
      this.applyFocus(focus)
      this.renderBranchesPane()
      this.renderCommitsPane()
      this.recomputeLayout()
      this.syncPreviewForFocus(focus)
    }
    this.handleResize = () => {
      this.recomputeLayout()
    }
    this.handleKey = (key: KeyEvent) => {
      const normalized = normalizeKey(key)
      const routedKey = {
        ...key,
        name: normalized.name,
        ctrl: normalized.ctrl,
        shift: normalized.shift,
        meta: normalized.meta,
        option: normalized.option,
      } as KeyEvent

      if (routedKey.name === "escape") {
        this.pendingClick = undefined
        this.cancelGesture()
      }
      if (routedKey.name === "escape" && this.commitsPanel.child !== undefined) {
        this.actionBack()
        key.preventDefault()
        key.stopPropagation()
        return
      }

      // Dialogs consume raw characters, so modal input keeps its own path.
      if (this.modalInputActive()) {
        this.handleModalKey(routedKey)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      const action = this.registry.dispatch(routedKey, {
        context: this.focusManager.active,
        model: this.model,
        ui: this.uiState(),
      })
      if (action === undefined) return
      this.handleAction(action, routedKey)
      key.preventDefault()
      key.stopPropagation()
    }
    renderer.on("resize", this.handleResize)
    renderer.keyInput.on("keypress", this.handleKey)
    this.installMouseHandlers()
    this.applyFocus(this.focusManager.active)
    this.applyLayout()
    // Every action in `ACTIONS` has a `case` in `handleAction`'s switch (its `default` case
    // assigns the unhandled value to a `never`, so the compiler rejects a build where that isn't
    // true), and `BindingRegistry`'s constructor already rejects any binding whose action is
    // outside `ACTIONS`. Together those two checks guarantee every binding this registry can
    // produce has a handler, so no runtime cross-check is needed here.
  }
  update(model: AppModel, options: { readonly preserveRemoteCheckout?: boolean } = {}): void {
    this.clearDiscardState()
    if (!options.preserveRemoteCheckout) {
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.branchFilter = ""
      this.filterInput.clear()
      this.filterInput.close()
    }
    this.model = model
    if (this.pendingStashDrop !== undefined && !(model.stashes ?? []).some((stash) => stash.oid === this.pendingStashDrop?.oid)) {
      this.pendingStashDrop = undefined
      this.panes.stash.box.bottomTitle = undefined
    }
    const pickerCount = model.basePicker?.candidates.length ?? 0
    this.basePickerIndex = pickerCount === 0 ? 0 : Math.min(this.basePickerIndex, pickerCount - 1)
    if (model.upstreamChoice !== undefined) {
      this.upstreamCursorIndex = Math.min(this.upstreamCursorIndex, Math.max(0, model.upstreamChoice.candidates.length - 1))
      const choices = model.upstreamChoice.candidates.map((candidate, index) => `${index + 1} ${candidate.remote}/${candidate.branch}`).join(" · ")
      this.panes.main.box.bottomTitle = `Upstream required for ${model.upstreamChoice.branch}: ${choices || "no candidates"} — choose a number`
    }
    updateStatusPane(this.panes.status, model)
    updateFilesPane(this.panes.files, model)
    this.refreshBranchesPanel(model)
    this.renderBranchesPane()
    const focusedIndex = model.focusId === undefined ? -1 : model.files.findIndex((file) => file.path === model.focusId)
    this.fileCursorIndex = focusedIndex >= 0
      ? focusedIndex
      : model.files.length === 0 ? 0 : Math.min(this.fileCursorIndex, model.files.length - 1)
    this.refreshCommitsPanel(model)
    this.renderCommitsPane()
    updateStashPane(this.panes.stash, model)
    this.syncPreviewForFocus(this.focusManager.active)
    this.commandLog.update(model.commandLog)
    this.recomputeLayout()
  }
  private clearDiscardState(): void {
    this.discardPending = false
    this.pendingDiscardPaths = []
    this.pendingFileDiscard = undefined
  }
  private modalInputActive(): boolean {
    return this.branchFilterActive || this.commitDialog !== undefined || this.copyMenuOpen ||
      this.menuOpen ||
      this.model.upstreamChoice !== undefined || this.model.basePicker !== undefined ||
      this.pendingBranchDelete !== undefined || this.pendingRemoteMismatch !== undefined ||
      this.pendingStashDrop !== undefined || this.pendingFileDiscard !== undefined || this.discardPending
  }

  /** Whether a mutation (git operation triggered via `runUiMutation`) is currently in flight. */
  get isMutating(): boolean {
    return this.mutationInFlight
  }

  /** The main pane's text viewport scroll positions, for tests and diagnostics. */
  get mainScrollY(): number { return this.panes.main.text.scrollY }
  get mainScrollX(): number { return this.panes.main.text.scrollX }
  /** The commits pane's list cursor index. */
  get commitsCursorIndex(): number {
    const panel = this.commitsPanel
    if (panel.child !== undefined) return panel.child.view.selectedIndex
    return panel.views.commits?.selectedIndex ?? 0
  }
  get mainPane(): PaneHandle { return this.panes.main }
  get commitsPane(): PaneHandle { return this.panes.commits }
  get filesPane(): PaneHandle { return this.panes.files }
  get branchesPane(): PaneHandle { return this.panes.branches }
  get stashPane(): PaneHandle { return this.panes.stash }
  get statusPane(): PaneHandle { return this.panes.status }
  paneFor(id: (typeof FOCUS_IDS)[number]): PaneHandle {
    return this.panes[id]
  }
  get commitsSelectedOid(): string | undefined {
    const panel = this.commitsPanel
    if (panel.child !== undefined) return panel.child.view.selectedId?.split("\u0000")[0] ?? panel.child.value.oid
    return panel.views.commits?.selectedId
  }
  paneScrollY(id: FocusId): number {
    if (id === "command-log") return this.commandLog.text.scrollY
    const pane = (this.panes as Record<string, PaneHandle>)[id]
    return pane?.text.scrollY ?? 0
  }
  paneTextGeometry(id: FocusId): { readonly screenX: number; readonly screenY: number; readonly width: number; readonly height: number } | undefined {
    const name = id === "command-log" ? "log" : id
    const win = (this.geometry.windows as Record<string, { x0: number; y0: number; x1: number; y1: number } | undefined>)[name]
    if (win === undefined) return undefined
    return {
      screenX: win.x0 + 1,
      screenY: win.y0 + 1,
      width: Math.max(1, widthOf(win as unknown as never) - 2),
      height: Math.max(1, heightOf(win as unknown as never) - 2),
    }
  }
  cancelGesture(): void {
    this.gestureOwner = undefined
    this.activeSplitterDrag = undefined
  }
  get activeBranchesTab(): "branches" | "remotes" | "tags" {
    return this.branchesPanel.activeTab
  }

  private uiState(): UiState {
    const target = this.model.reviewTarget
    const selected = this.selectedBranchesItem()
    let kind: UiState["selectedBranchKind"]
    if (selected !== undefined) {
      if (selected.id.startsWith("local:")) kind = "local"
      else if (selected.id.startsWith("remote-branch:")) kind = "remote-branch"
      else if (selected.id.startsWith("remote:")) kind = "remote"
      else kind = undefined
    } else {
      kind = undefined
    }
    return {
      focus: this.focusManager.active,
      currentSideWindow: this.focusManager.lastSide,
      screenMode: this.geometry.screenMode,
      modal: this.modalInputActive(),
      mainScope: target.kind === "working-tree" ? target.scope : undefined,
      selectedBranchKind: kind,
      hasSelectedStash: selectedStashEntry(this.panes.stash, this.model) !== undefined,
    }
  }

  private selectedBranchesItem(): { readonly id: string } | undefined {
    const state = this.branchesPanel.child?.view ?? this.branchesPanel.views[this.branchesPanel.activeTab]
    if (state === undefined || state.rows.length === 0) return undefined
    const id = state.selectedId
    if (id === undefined) return undefined
    return { id }
  }

  private plainChunk(text: string): TextChunk {
    return { __isChunk: true as const, text } as unknown as TextChunk
  }

  get branchesTitleStyled(): StyledText {
    const active = this.branchesPanel.activeTab
    const parts: Array<{ readonly text: string; readonly tab: "branches" | "remotes" | "tags" }> = [
      { text: "Local Branches", tab: "branches" },
      { text: "Remotes", tab: "remotes" },
      { text: "Tags", tab: "tags" },
    ]
    const chunks: TextChunk[] = []
    chunks.push(this.plainChunk("3 "))
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isActive = part.tab === active
      const chunk = isActive ? (cyan(part.text) as unknown as TextChunk) : (dim(part.text) as unknown as TextChunk)
      chunks.push(chunk)
      if (i < parts.length - 1) chunks.push(this.plainChunk(" | "))
    }
    return new StyledText(chunks)
  }

  private refreshBranchesPanel(model: AppModel): void {
    const branchesRows = localBranchRows(model, this.branchFilter)
    const remotesRowsData = remoteRows(model, this.branchFilter)
    const tagsRowsData = tagRows(model, this.branchFilter)
    let panel = this.branchesPanel
    panel = { ...panel, views: { ...panel.views, branches: setListRows(panel.views.branches, branchesRows) } }
    panel = { ...panel, views: { ...panel.views, remotes: setListRows(panel.views.remotes, remotesRowsData) } }
    panel = { ...panel, views: { ...panel.views, tags: setListRows(panel.views.tags, tagsRowsData) } }
    if (panel.child !== undefined && panel.child.value.kind === "remote-branches") {
      const remote = panel.child.value.remote
      const remoteBranchRowsData = remoteBranchRows(model, remote, this.branchFilter)
      const nextChildView = setListRows(panel.child.view, remoteBranchRowsData)
      panel = { ...panel, child: { ...panel.child, view: nextChildView } }
    }
    this.branchesPanel = panel
  }

  private renderBranchesPane(): void {
    const pane = this.panes.branches
    const styledTitle = this.branchesTitleStyled
    const boxTitleTarget = pane.box as unknown as { title: unknown }
    boxTitleTarget.title = styledTitle as unknown as string
    const focused = this.focusManager.active === "branches"
    const state = this.branchesPanel.child?.view ?? this.branchesPanel.views[this.branchesPanel.activeTab]
    if (state === undefined) {
      pane.update("")
      return
    }
    const win = this.geometry.windows.branches
    const width = win !== undefined ? Math.max(10, widthOf(win) - 2) : 80
    const content = renderListRows(state, focused, width)
    pane.update(content)
    pane.syncScrollbar()
  }


  private handleAction(action: Action, key: KeyEvent): void {
    switch (action) {
      case "quit": this.onQuit?.(); return
      case "focus-main": this.focusManager.focus("main"); return
      case "focus-status": this.focusManager.focus("status"); return
      case "focus-files": this.focusManager.focus("files"); return
      case "focus-branches": this.focusManager.focus("branches"); return
      case "focus-commits": this.focusManager.focus("commits"); return
      case "focus-stash": this.focusManager.focus("stash"); return
      case "command-log": this.focusManager.handleKey("@"); return
      case "pane-next": this.focusManager.cycle("next"); return
      case "pane-previous": this.focusManager.cycle("previous"); return
      case "next": this.actionMoveCursor("next"); return
      case "previous": this.actionMoveCursor("previous"); return
      case "stage-file": this.actionStageFile(); return
      case "discard-file": this.actionDiscardFile(); return
      case "stage-all": this.actionStageAll(); return
      case "mark-reviewed": this.actionMarkReviewed(); return
      case "inspect": this.actionInspect(); return
      case "stage-selection": this.actionStageSelection(); return
      case "discard-selection": this.actionDiscardSelection(); return
      case "tab-next": this.actionCycleTab("next"); return
      case "tab-previous": this.actionCycleTab("previous"); return
      case "branch-checkout": this.actionBranchCheckout(); return
      case "branch-create": this.actionBranchCreate(); return
      case "branch-delete": this.actionBranchDelete(key.shift === true); return
      case "branch-rename": this.actionBranchRename(); return
      case "fetch-remote": this.actionFetchRemote(); return
      case "commit-drilldown": this.actionCommitDrilldown(); return
      case "commit-back": this.actionCommitBack(); return
      case "back": this.actionBack(); return
      case "stash-create": this.actionStashCreate(); return
      case "stash-apply": this.actionStashApply(); return
      case "stash-pop": this.actionStashPop(); return
      case "stash-drop": this.actionStashDrop(); return
      case "stash-inspect": this.actionStashInspect(); return
      case "commit": this.actionCommit(); return
      case "amend": this.actionAmend(); return
      case "fetch": this.actionFetch(); return
      case "pull": this.actionPull(); return
      case "push": this.actionPush(); return
      case "refresh": this.actionRefresh(); return
      case "mode-branch": this.actionModeBranch(); return
      case "mode-working-tree": this.actionModeWorkingTree(); return
      case "filter": this.actionFilter(); return
      case "copy-menu": this.actionCopyMenu(); return
      case "copy-exact": this.actionCopyExact(); return
      case "modal-cancel": case "modal-confirm": case "filter-backspace":
        this.handleModalKey(key); return
      case "screen-mode-next":
        this.screenMode = nextScreenMode(this.screenMode)
        this.recomputeLayout()
        return
      case "screen-mode-previous":
        this.screenMode = previousScreenMode(this.screenMode)
        this.recomputeLayout()
        return
      case "keybinding-menu":
        this.menuOpen = !this.menuOpen
        this.recomputeLayout()
        return
      case "main-scroll-down": scrollMainPane(this.panes.main, "y", 1); this.root.requestRender(); return
      case "main-scroll-up": scrollMainPane(this.panes.main, "y", -1); this.root.requestRender(); return
      case "main-scroll-right": scrollMainPane(this.panes.main, "x", 4); this.root.requestRender(); return
      case "main-scroll-left": scrollMainPane(this.panes.main, "x", -4); this.root.requestRender(); return
      case "main-half-page-down": scrollMainPane(this.panes.main, "y", this.mainPageStep()); this.root.requestRender(); return
      case "main-half-page-up": scrollMainPane(this.panes.main, "y", -this.mainPageStep()); this.root.requestRender(); return
      case "page-next": this.actionPage("next"); return
      case "page-previous": this.actionPage("previous"); return
      case "goto-top": this.actionJump("top"); return
      case "goto-bottom": this.actionJump("bottom"); return
      // hunk-next/previous are the same hunk-granular move j/k already perform in the
      // main pane; reuse it so both report cursor position identically.
      case "hunk-next": this.moveMainCursor("next"); return
      case "hunk-previous": this.moveMainCursor("previous"); return
      default: {
        const unhandled: never = action
        return unhandled
      }
    }
  }

  private handleModalKey(key: KeyEvent): void {
    if (this.menuOpen) {
      if (key.name === "escape" || key.name === "?") {
        this.menuOpen = false
        this.recomputeLayout()
      }
      return
    }
    if (this.branchFilterActive) {
      this.handleFilterKey(key)
      return
    }
    if (this.commitDialog !== undefined) {
      const mode = this.commitDialog.state.mode
      if (mode === "stash") {
        if (this.mutationInFlight) return
        if (key.name === "u" && key.ctrl === true && !key.meta) {
          this.stashIncludeUntracked = !this.stashIncludeUntracked
          this.panes.main.box.bottomTitle = `${renderCommitDialog(this.commitDialog.state)}\nInclude untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`
          this.root.requestRender()
          return
        }
        this.handleStashDialogKey(key)
        return
      }
      if (mode === "branch-create" || mode === "branch-rename") {
        if (this.mutationInFlight) return
        this.handleBranchDialogKey(key)
        return
      }
      if (this.mutationInFlight) return
      this.handleCommitDialogKey(key)
      return
    }
    if (this.copyMenuOpen) {
      if (key.name === "escape") {
        this.copyMenuOpen = false
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return
      }
      const index = Number(key.name) - 1
      if (Number.isInteger(index) && index >= 0 && index < COPY_MENU_ITEMS.length) {
        this.copyMenuOpen = false
        this.copyMainMode(COPY_MENU_ITEMS[index]!.mode)
      }
      return
    }
    if (this.model.upstreamChoice !== undefined) {
      if (this.mutationInFlight) return
      if (key.name === "escape") {
        if (this.onCancelUpstream !== undefined) this.runUiMutation(() => this.onCancelUpstream!())
        return
      }
      if (this.onChooseUpstream === undefined) return
      const count = this.model.upstreamChoice.candidates.length
      const numeric = Number(key.name) - 1
      if (Number.isInteger(numeric) && numeric >= 0 && numeric < count) {
        const choice = this.model.upstreamChoice.candidates[numeric]!
        this.runUiMutation(() => this.onChooseUpstream!(choice.remote, choice.branch))
        return
      }
      if (count > 0 && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
        this.upstreamCursorIndex = Math.max(0, Math.min(count - 1, this.upstreamCursorIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        return
      }
      if (count > 0 && key.name === "enter") {
        const choice = this.model.upstreamChoice.candidates[this.upstreamCursorIndex]!
        this.runUiMutation(() => this.onChooseUpstream!(choice.remote, choice.branch))
      }
      return
    }
    if (this.model.basePicker !== undefined) {
      if (this.mutationInFlight) return
      if (key.name === "escape") {
        if (this.onCancelBase !== undefined) this.runUiMutation(() => this.onCancelBase!())
        return
      }
      if (this.onChooseBase === undefined) return
      const count = this.model.basePicker.candidates.length
      const numericIndex = Number(key.name) - 1
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < count) {
        this.runUiMutation(() => this.onChooseBase!(this.model.basePicker!.candidates[numericIndex]!))
        return
      }
      if (count > 0 && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
        this.basePickerIndex = Math.max(0, Math.min(count - 1, this.basePickerIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        this.panes.status.box.bottomTitle = `${this.basePickerIndex + 1}/${count}: ${this.model.basePicker.candidates[this.basePickerIndex]} — Enter to choose`
        return
      }
      if (count > 0 && key.name === "enter") {
        this.runUiMutation(() => this.onChooseBase!(this.model.basePicker!.candidates[this.basePickerIndex]!))
      }
      return
    }
    // A pending two-press confirmation (branch delete, stash drop, file/selection discard,
    // remote-tracking mismatch) is also modal input: the confirming or cancelling keystroke
    // must re-run the same pane action rather than fall through to the registry. Each dispatch
    // below is guarded by re-resolving the key through the registry (with the current context,
    // model and ui) so the binding's `available` predicate still governs it — the same rule the
    // non-modal path enforces. Without this, a key that happens to match "d" or "enter" here
    // would bypass the predicate entirely (e.g. deleting a branch that isn't the selected one).
    if (key.name === "escape") {
      this.actionBack()
      return
    }
    if (key.name === "d" || key.name === "enter") {
      const resolvedAction = this.resolveModalAction(key)
      switch (this.focusManager.active) {
        case "files":
          if (key.name === "d" && resolvedAction === "discard-file") this.actionDiscardFile()
          return
        case "branches":
          if (key.name === "d" && resolvedAction === "branch-delete") this.actionBranchDelete(key.shift === true)
          if (key.name === "enter" && resolvedAction === "inspect") this.actionBranchInspect()
          return
        case "stash":
          if (key.name === "d" && resolvedAction === "stash-drop") this.actionStashDrop()
          return
        case "main":
          if (key.name === "d" && resolvedAction === "discard-selection") this.actionDiscardSelection()
          return
        default:
          return
      }
    }
  }

  /**
   * Resolves `key` through the registry using the current pane context, model and ui — the same
   * availability-aware resolution `handleKey` uses on the non-modal path. `handleModalKey`'s
   * confirm/cancel tail uses this to decide whether a two-press confirmation may actually act,
   * rather than calling the action method unconditionally and re-implementing its guard inline.
   */
  private resolveModalAction(key: KeyEvent): Action | undefined {
    return this.registry.resolve(key, {
      context: this.focusManager.active,
      model: this.model,
      ui: this.uiState(),
    })?.action
  }

  private handleFilterKey(key: KeyEvent): boolean {
    if (!this.branchFilterActive) return false
    const result = this.filterInput.handleKey(key)
    if (result.cancelled) {
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilter = ""
      this.filterInput.clear()
    } else {
      this.branchFilter = this.filterInput.state.query
    }
    this.branchFilterActive = this.filterInput.state.active
    this.refreshBranchesPanel(this.model)
    this.renderBranchesPane()
    return result.consumed
  }


  private actionMoveCursor(direction: "next" | "previous"): void {
    switch (this.focusManager.active) {
      case "files": {
        this.clearDiscardState()
        this.fileCursorIndex = Math.max(0, Math.min(this.model.files.length - 1, this.fileCursorIndex + (direction === "next" ? 1 : -1)))
        const selected = this.model.files[this.fileCursorIndex]
        this.panes.files.box.bottomTitle = selected?.path ?? "No files"
        if (selected !== undefined) this.onSelectFile?.(selected.path)
        this.revealListRow("files", this.panes.files, this.fileCursorIndex)
        const content = this.presentFilesContent(this.model)
        this.mainGate.installSynchronous(content)
        this.root.requestRender()
        return
      }
      case "branches": {
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        const panel = this.branchesPanel
        if (panel.child !== undefined) {
          const nextView = moveListSelection(panel.child.view, direction)
          if (nextView !== panel.child.view) {
            this.branchesPanel = { ...panel, child: { ...panel.child, view: nextView } }
            this.renderBranchesPane()
            this.revealListRow("branches", this.panes.branches, nextView.selectedIndex)
            this.syncPreviewForFocus("branches")
          }
        } else {
          const active = panel.activeTab
          const currentView = panel.views[active]!
          const nextView = moveListSelection(currentView, direction)
          if (nextView !== currentView) {
            this.branchesPanel = { ...panel, views: { ...panel.views, [active]: nextView } }
            this.renderBranchesPane()
            this.revealListRow("branches", this.panes.branches, nextView.selectedIndex)
            this.syncPreviewForFocus("branches")
          }
        }
        return
      }
      case "commits": {
        const panel = this.commitsPanel
        if (panel.child !== undefined) {
          const nextView = moveListSelection(panel.child.view, direction)
          if (nextView !== panel.child.view) {
            this.commitsPanel = { ...panel, child: { ...panel.child, view: nextView } }
            this.renderCommitsPane()
            this.revealListRow("commits", this.panes.commits, nextView.selectedIndex)
            this.syncPreviewForFocus("commits")
          }
        } else {
          const currentView = panel.views.commits!
          const nextView = moveListSelection(currentView, direction)
          if (nextView !== currentView) {
            this.commitsPanel = { ...panel, views: { ...panel.views, commits: nextView } }
            this.renderCommitsPane()
            this.revealListRow("commits", this.panes.commits, nextView.selectedIndex)
            this.syncPreviewForFocus("commits")
          }
        }
        return
      }
      case "stash":
        this.pendingStashDrop = undefined
        this.panes.stash.box.bottomTitle = undefined
        moveStashCursor(this.panes.stash, this.model, direction)
        this.revealListRow("stash", this.panes.stash, stashCursorIndex(this.panes.stash))
        this.syncPreviewForFocus("stash")
        return
      case "main":
        // j/k (and h/l via hunk-next/previous) move the hunk cursor here:
        // MainCursorTarget is hunk-granular and githunk has no line cursor yet.
        this.moveMainCursor(direction)
        return
      default:
        return
    }
  }


  /**
   * Scrolls a pane so the given content row is on screen after a cursor move. The viewport
   * height is read from computeLayout's windows map rather than from `text.height`: the
   * layout engine computes asynchronously, so `text.height` can be stale at cursor-move
   * time, while this.geometry is updated synchronously by recomputeLayout (the same
   * source focusedPageStep and mainPageStep already trust).
   */
  private revealListRow(name: SideWindow | "main", pane: PaneHandle, line: number): void {
    const visibleLines = Math.max(1, heightOf(this.geometry.windows[name]) - 2)
    pane.text.scrollY = scrollYToReveal(line, line, visibleLines, pane.text.scrollY)
    // No scroll-change event exists in OpenTUI 0.5.6: without this the thumb freezes
    // whenever a reveal mutates scrollY without a content update.
    pane.syncScrollbar()
  }

  /** Half the main pane's visible rows, at least one. */
  private mainPageStep(): number {
    return Math.max(1, Math.floor(heightOf(this.geometry.windows.main) / 2))
  }

  /** The visible rows of the focused pane, at least one, used as the page step. */
  private focusedPageStep(): number {
    const focus = this.focusManager.active
    const dimensions = focus === "command-log"
      ? this.geometry.windows.log
      : this.geometry.windows[focus as SideWindow] ?? this.geometry.windows.main
    return Math.max(1, heightOf(dimensions) - 2)
  }

  private actionPage(direction: "next" | "previous"): void {
    const step = this.focusedPageStep()
    for (let moved = 0; moved < step; moved += 1) this.actionMoveCursor(direction)
  }

  private actionJump(edge: "top" | "bottom"): void {
    // Lists are short enough that repeating the single-step move is simpler
    // and cannot disagree with it about clamping or selection side effects.
    const direction = edge === "bottom" ? "next" : "previous"
    const branchCount = this.branchesPanel.child !== undefined
      ? this.branchesPanel.child.view.rows.length
      : this.branchesPanel.views[this.branchesPanel.activeTab]?.rows.length ?? 0
    const limit = Math.max(
      this.model.files.length,
      (this.model.commits ?? []).length,
      (this.model.stashes ?? []).length,
      branchCount,
    ) + 1
    for (let moved = 0; moved < limit; moved += 1) this.actionMoveCursor(direction)
  }


  private actionInspect(): void {
    switch (this.focusManager.active) {
      case "files":
        this.actionOpenFile()
        return
      case "branches":
        this.actionBranchInspect()
        return
      default:
        return
    }
  }

  private actionOpenFile(): void {
    if (this.mutationInFlight) return
    const selected = this.model.files[this.fileCursorIndex]
    if (selected !== undefined) {
      this.onSelectFile?.(selected.path)
    }
    this.focusManager.focus("main")
  }

  private actionStageFile(): void {
    if (this.mutationInFlight) return
    if (this.model.reviewTarget.kind === "branch") {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return
    }
    const file = this.model.files[this.fileCursorIndex]
    if (file === undefined) return
    const staged = !file.untracked && file.worktreeStatus === "." && file.indexStatus !== "."
    const operation = staged ? this.onUnstageFile : this.onStageFile
    if (operation !== undefined) this.runUiMutation(() => operation(file.path))
  }

  private actionDiscardFile(): void {
    if (this.mutationInFlight) return
    if (this.model.reviewTarget.kind === "branch") {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return
    }
    const file = this.model.files[this.fileCursorIndex]
    if (file === undefined || this.onDiscardFile === undefined) return
    if (!file.untracked && file.worktreeStatus === "." && file.indexStatus !== ".") {
      this.panes.files.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
      return
    }
    const pending = this.pendingFileDiscard
    if (pending?.path === file.path && pending.untracked === file.untracked) {
      this.pendingFileDiscard = undefined
      this.runUiMutation(() => this.onDiscardFile!(file.path, file.untracked))
    } else {
      this.pendingFileDiscard = { path: file.path, untracked: file.untracked }
      this.panes.files.box.bottomTitle = `${discardConfirmation(file.path, file.untracked).message} Press d again to confirm or Escape to cancel.`
    }
  }

  private actionStageAll(): void {
    if (this.mutationInFlight) {
      this.panes.main.box.bottomTitle = "Mutation in progress; wait for refresh"
      return
    }
    if (this.model.reviewTarget.kind === "branch") {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return
    }
    if (this.onToggleAllFiles === undefined) return
    this.runUiMutation(() => this.onToggleAllFiles!())
  }

  private actionMarkReviewed(): void {
    if (this.mutationInFlight) return
    if (this.onMarkFocusedFileReviewed === undefined) return
    const file = this.model.files[this.fileCursorIndex]
    const focusedPath = this.model.focusId ?? this.model.selectionId
    const reviewPath = focusedPath !== undefined && this.model.files.some((candidate) => candidate.path === focusedPath)
      ? focusedPath
      : file?.path
    this.runUiMutation(() => this.onMarkFocusedFileReviewed!(reviewPath))
  }

  private actionStageSelection(): void {
    if (this.mutationInFlight) return
    if (this.onApplySelection === undefined) return
    if (this.model.reviewTarget.kind === "branch") {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all") {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press ] to choose staged or unstaged"
      return
    }
    const selected = this.mainChangeSelection()
    const document = getMainDocument(this.panes.main)
    const target = getMainCursorTarget(this.panes.main)
    const parsedPath = target === undefined || document === undefined ? undefined : document.files[target.fileIndex]?.newPath ?? document.files[target.fileIndex]?.oldPath
    const modelFile = parsedPath === undefined ? undefined : this.model.files.find((file) => file.path === parsedPath)
    const availability = modelFile?.conflicted
      ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: conflicted file" }
      : modelFile !== undefined && !modelFile.untracked && modelFile.additions === 0 && modelFile.deletions === 0
        ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary file" }
        : mainActionAvailability(document, target)
    if (!availability.canStageLines) {
      this.panes.main.box.bottomTitle = availability.reason
    } else if (selected === undefined || selected.indexes.length === 0) {
      this.panes.main.box.bottomTitle = "No changed lines selected"
    } else {
      const reverse = this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged"
      this.runUiMutation(() => this.onApplySelection!(selected.document, selected.indexes, reverse))
    }
  }

  private actionDiscardSelection(): void {
    if (this.mutationInFlight) return
    if (this.onDiscardSelection === undefined) return
    if (this.model.reviewTarget.kind === "branch") {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all") {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press ] to choose staged or unstaged"
      return
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged") {
      this.panes.main.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
      return
    }
    const selected = this.mainChangeSelection()
    const target = getMainCursorTarget(this.panes.main)
    const document = getMainDocument(this.panes.main)
    const targetFile = target === undefined || document === undefined ? undefined : document.files[target.fileIndex]
    const path = targetFile?.newPath !== undefined && targetFile.newPath !== "/dev/null" ? targetFile.newPath : targetFile?.oldPath ?? "selected changes"
    const modelFile = this.model.files.find((file) => file.path === path)
    if (modelFile?.untracked && this.onDiscardFile !== undefined) {
      const pending = this.pendingFileDiscard
      if (pending?.path === path && pending.untracked) {
        this.pendingFileDiscard = undefined
        this.runUiMutation(() => this.onDiscardFile!(path, true))
      } else {
        this.pendingFileDiscard = { path, untracked: true }
        this.panes.main.box.bottomTitle = `${discardConfirmation(path, true).message} Press d again to confirm or Escape to cancel.`
      }
      return
    }
    const availability = modelFile?.conflicted
      ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: conflicted file" }
      : modelFile !== undefined && !modelFile.untracked && modelFile.additions === 0 && modelFile.deletions === 0
        ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary file" }
        : mainActionAvailability(document, target)
    if (!availability.canDiscardLines) {
      this.panes.main.box.bottomTitle = availability.reason
      return
    }
    if (selected === undefined || selected.indexes.length === 0) {
      this.panes.main.box.bottomTitle = "No changed lines selected"
    } else {
      const paths = this.selectionPaths(selected.document, selected.indexes)
      const label = paths.join(", ")
      if (!this.discardPending || this.pendingDiscardPaths.join("\0") !== paths.join("\0")) {
        this.discardPending = true
        this.pendingDiscardPaths = paths
        this.panes.main.box.bottomTitle = `${discardConfirmation(label || path).message} Press d again to confirm or Escape to cancel.`
      } else {
        this.clearDiscardState()
        this.runUiMutation(() => this.onDiscardSelection!(selected.document, selected.indexes))
      }
    }
  }

  private actionCycleTab(direction: "next" | "previous"): void {
    if (this.focusManager.active !== "branches") return
    this.branchesPanel = cyclePanelTab(this.branchesPanel, direction)
    this.renderBranchesPane()
    this.root.requestRender()
  }
  private actionBranchCheckout(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) {
      const state = panel.child.view
      const id = state.selectedId
      if (id !== undefined && id.startsWith("remote-branch:") && this.onCheckoutRemoteTracking !== undefined) {
        const ref = id.slice("remote-branch:".length)
        const remote = panel.child.value.remote
        const name = ref.slice(remote.length + 1)
        this.runRemoteCheckout({ remote, branch: name, ref }, false)
      }
      return
    }
    const view = panel.views[panel.activeTab]
    const id = view?.selectedId
    if (id === undefined) return
    if (id.startsWith("local:") && this.onSwitchLocalBranch !== undefined) {
      const name = id.slice("local:".length)
      this.runUiMutation(() => this.onSwitchLocalBranch!(name))
    }
  }

  private actionBranchCreate(): void {
    if (this.mutationInFlight) return
    if (this.onCreateBranch === undefined) return
    const panel = this.branchesPanel
    let startPoint: string | undefined
    if (panel.child === undefined && panel.activeTab === "branches") {
      const id = panel.views.branches?.selectedId
      if (id !== undefined && id.startsWith("local:")) startPoint = id.slice("local:".length)
    }
    this.branchDialogContext = { mode: "branch-create", ...(startPoint === undefined ? {} : { startPoint }) }
    this.openBranchDialog("branch-create", "")
  }

  private actionBranchDelete(force: boolean): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) return
    if (panel.activeTab !== "branches") return
    const id = panel.views.branches?.selectedId
    if (id === undefined || !id.startsWith("local:") || this.onDeleteBranch === undefined) return
    const name = id.slice("local:".length)
    const pending = this.pendingBranchDelete
    if (pending?.branch === name && pending.force === force) {
      this.pendingBranchDelete = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onDeleteBranch!(name, force))
    } else {
      this.pendingBranchDelete = { branch: name, force }
      const confirmation = branchDeleteConfirmation(name, force)
      this.panes.branches.box.bottomTitle = `${confirmation.message} Press ${force ? "D" : "d"} again to confirm or Escape to cancel.`
    }
  }

  private actionBranchRename(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) return
    if (panel.activeTab !== "branches") return
    const id = panel.views.branches?.selectedId
    if (id === undefined || !id.startsWith("local:") || this.onRenameBranch === undefined) return
    const name = id.slice("local:".length)
    this.branchDialogContext = { mode: "branch-rename", branch: name }
    this.openBranchDialog("branch-rename", "")
  }

  private actionFetchRemote(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) return
    if (panel.activeTab !== "remotes") return
    const id = panel.views.remotes?.selectedId
    if (id === undefined || !id.startsWith("remote:") || this.onFetchRemote === undefined) return
    const name = id.slice("remote:".length)
    this.runUiMutation(() => this.onFetchRemote!(name))
  }

  private actionBranchInspect(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) {
      const state = panel.child.view
      const id = state.selectedId
      if (id !== undefined && id.startsWith("remote-branch:")) {
        const ref = id.slice("remote-branch:".length)
        const remote = panel.child.value.remote
        const name = ref.slice(remote.length + 1)
        const selection = { remote, branch: name, ref }
        if (this.pendingRemoteMismatch !== undefined &&
          this.pendingRemoteMismatch.selection.remote === selection.remote &&
          this.pendingRemoteMismatch.selection.branch === selection.branch &&
          this.pendingRemoteMismatch.selection.ref === selection.ref) {
          this.runRemoteCheckout(selection, true)
        } else {
          this.invalidateRemoteCheckout()
          this.panes.branches.box.bottomTitle = undefined
          if (this.onInspectBranch !== undefined) this.runUiMutation(() => this.onInspectBranch!(ref))
        }
      }
      return
    }
    const view = panel.views[panel.activeTab]
    const id = view?.selectedId
    if (id === undefined) return
    if (id.startsWith("local:")) {
      const name = id.slice("local:".length)
      if (this.onInspectBranch !== undefined) {
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.runUiMutation(() => this.onInspectBranch!(name))
      }
    } else if (id.startsWith("remote:")) {
      const remote = id.slice("remote:".length)
      const rows = remoteBranchRows(this.model, remote, this.branchFilter)
      const childView = createListState(rows)
      this.branchesPanel = enterPanelChild(this.branchesPanel, { kind: "remote-branches", remote }, childView)
      this.renderBranchesPane()
      if (this.onBrowseRemote !== undefined) {
        this.runUiMutation(() => this.onBrowseRemote!(remote))
      }
    } else if (id.startsWith("tag:")) {
      // Tag preview wiring deferred to Task 5; no-op here preserves navigation-only contract
    }
  }

  private actionCommitDrilldown(): void {
    if (this.mutationInFlight) return
    if (this.commitsPanel.child !== undefined) return
    const selectedId = this.commitsPanel.views.commits?.selectedId
    if (selectedId === undefined || this.loadCommitInspection === undefined) return
    const oid = selectedId
    this.previewInflight = this.loadCommitInspection(oid).then((details) => {
      const fileRows = commitFileRows(details)
      if (fileRows.length === 0) {
        const emptyView = createListState([], [{ kind: "message", text: "No files" }])
        this.commitsPanel = enterPanelChild(this.commitsPanel, { kind: "commit-files", oid, details }, emptyView)
        this.renderCommitsPane()
        const content = this.presentCommitContent(details)
        this.mainGate.installSynchronous(content)
        this.root.requestRender()
        return
      }
      const view = createListState(fileRows)
      this.commitsPanel = enterPanelChild(this.commitsPanel, { kind: "commit-files", oid, details }, view)
      this.renderCommitsPane()
      this.syncPreviewForFocus("commits")
      this.root.requestRender()
    }).catch((error: unknown) => {
      this.onPreviewError?.(error)
      this.root.requestRender()
    })
  }

  private actionCommitBack(): void {
    if (this.commitsPanel.child !== undefined) {
      const oid = this.commitsPanel.child.value.oid
      this.commitsPanel = leavePanelChild(this.commitsPanel)
      this.renderCommitsPane()
      if (this.loadCommitInspection !== undefined) {
        const load = (): Promise<CommitDetails> => this.loadCommitInspection!(oid)
        const present = (details: CommitDetails): MainPaneContent => this.presentCommitContent(details)
        const promise = this.mainGate.request("commit", oid, load, present)
        this.previewInflight = promise.catch(() => {})
      }
      this.root.requestRender()
    }
  }

  private actionBack(): void {
    if (this.commitsPanel.child !== undefined) {
      const oid = this.commitsPanel.child.value.oid
      this.commitsPanel = leavePanelChild(this.commitsPanel)
      this.renderCommitsPane()
      if (this.loadCommitInspection !== undefined) {
        const load = (): Promise<CommitDetails> => this.loadCommitInspection!(oid)
        const present = (details: CommitDetails): MainPaneContent => this.presentCommitContent(details)
        const promise = this.mainGate.request("commit", oid, load, present)
        this.previewInflight = promise.catch(() => {})
      }
      this.root.requestRender()
      return
    }
    if (this.pendingStashDrop !== undefined) {
      this.panes.stash.box.bottomTitle = undefined
    }
    if (this.branchesPanel.child !== undefined) {
      this.branchesPanel = leavePanelChild(this.branchesPanel)
      this.renderBranchesPane()
      this.root.requestRender()
    } else if (this.pendingBranchDelete !== undefined || this.pendingRemoteMismatch !== undefined || this.branchFilterActive || this.remoteCheckoutInFlight) {
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.filterInput.clear()
      this.filterInput.close()
      this.branchFilter = ""
      this.refreshBranchesPanel(this.model)
      this.renderBranchesPane()
    }
    if (this.pendingFileDiscard !== undefined) {
      this.clearDiscardState()
      this.panes.files.box.bottomTitle = undefined
    }
    if (this.discardPending) {
      this.clearDiscardState()
      this.panes.main.box.bottomTitle = undefined
    }
  }

  private actionStashCreate(): void {
    if (this.mutationInFlight || this.onCreateStash === undefined) return
    this.stashIncludeUntracked = false
    this.openCommitDialog("stash", "")
  }

  private actionStashApply(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntry(this.panes.stash, this.model)
    if (selected === undefined || this.onApplyStash === undefined) return
    this.runUiMutation(() => this.onApplyStash!(selected.oid))
  }

  private actionStashPop(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntry(this.panes.stash, this.model)
    if (selected === undefined || this.onPopStash === undefined) return
    this.runUiMutation(() => this.onPopStash!(selected.oid))
  }

  private actionStashDrop(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntry(this.panes.stash, this.model)
    if (selected === undefined || this.onDropStash === undefined) return
    if (this.pendingStashDrop?.oid === selected.oid) {
      this.pendingStashDrop = undefined
      this.panes.stash.box.bottomTitle = undefined
      this.runUiMutation(() => this.onDropStash!(selected.oid))
    } else {
      this.pendingStashDrop = selected
      this.panes.stash.box.bottomTitle = `Drop ${selected.ref}? Press d again to confirm or Escape to cancel.`
    }
  }

  private actionStashInspect(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntry(this.panes.stash, this.model)
    if (selected === undefined || this.onInspectStash === undefined) return
    this.runUiMutation(() => this.onInspectStash!(selected.oid))
  }

  private actionCommit(): void {
    if (this.mutationInFlight || this.onCommitMessage === undefined) return
    const commitAvailable = this.focusManager.active === "files"
      ? filesPaneCommitAvailable(this.model)
      : this.focusManager.active === "main" && mainPaneCommitAvailable(this.model)
    if (!commitAvailable) {
      this.panes.main.box.bottomTitle = "Commit is available in Files or Main staged scope"
      return
    }
    this.openCommitDialog("commit", "")
  }

  private actionAmend(): void {
    if (this.mutationInFlight || this.onAmendMessage === undefined || this.onCurrentCommitMessage === undefined) return
    const commitAvailable = this.focusManager.active === "files"
      ? filesPaneCommitAvailable(this.model)
      : this.focusManager.active === "main" && mainPaneCommitAvailable(this.model)
    if (!commitAvailable) {
      this.panes.main.box.bottomTitle = "Commit is available in Files or Main staged scope"
      return
    }
    this.openAmendDialog()
  }

  private actionFetch(): void {
    if (this.mutationInFlight || this.onFetch === undefined) return
    this.runUiMutation(() => this.onFetch!())
  }

  private actionPull(): void {
    if (this.mutationInFlight || this.onPull === undefined) return
    this.runUiMutation(() => this.onPull!())
  }

  private actionPush(): void {
    if (this.mutationInFlight || this.onPush === undefined) return
    this.runUiMutation(() => this.onPush!())
  }

  private actionRefresh(): void {
    if (this.onRefresh === undefined) return
    this.invalidateRemoteCheckout()
    this.panes.branches.box.bottomTitle = undefined
    this.runUiMutation(() => this.onRefresh!())
  }

  private actionModeBranch(): void {
    if (this.onModeChange === undefined || this.mutationInFlight) return
    this.invalidateRemoteCheckout()
    this.panes.branches.box.bottomTitle = undefined
    this.runUiMutation(() => this.onModeChange!("branch"))
  }

  private actionModeWorkingTree(): void {
    if (this.onModeChange === undefined || this.mutationInFlight) return
    this.invalidateRemoteCheckout()
    this.panes.branches.box.bottomTitle = undefined
    this.runUiMutation(() => this.onModeChange!("working-tree"))
  }

  private actionFilter(): void {
    if (this.focusManager.active !== "branches") return
    this.pendingBranchDelete = undefined
    this.invalidateRemoteCheckout()
    this.panes.branches.box.bottomTitle = undefined
    this.filterInput.open()
    this.branchFilterActive = true
    this.branchFilter = ""
    this.refreshBranchesPanel(this.model)
    this.renderBranchesPane()
  }


  private actionCopyMenu(): void {
    this.copyMenuOpen = true
    this.panes.main.box.bottomTitle = `Copy: ${COPY_MENU_ITEMS.map((item, index) => `${index + 1} ${item.label}`).join(" | ")}`
    this.root.requestRender()
  }

  private actionCopyExact(): void {
    this.copyMainMode("text")
  }

  private selectionPaths(document: DiffDocument, indexes: readonly number[]): readonly string[] {
    const paths = new Set<string>()
    for (const index of indexes) {
      const file = document.files[document.lines[index]?.fileIndex ?? -1]
      const path = file?.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file?.oldPath
      if (path !== undefined && path !== "/dev/null") paths.add(path)
    }
    return [...paths]
  }

  private mainChangeSelection(): { readonly document: DiffDocument; readonly indexes: readonly number[] } | undefined {
    const document = getMainDocument(this.panes.main)
    if (!document) return undefined
    const nativeRange = this.panes.main.text.getSelection()
    if (nativeRange) {
      const selection = selectionFromRenderable(document, nativeRange, this.panes.main.text.getSelectedText())
      if (selection.valid && selection.endUtf16 > selection.startUtf16) {
        return { document, indexes: changeLineIndexes(document, selection.startUtf16, selection.endUtf16) }
      }
    }
    const target = getMainCursorTarget(this.panes.main)
    if (!target) return undefined
    const file = document.files[target.fileIndex]
    if (!file) return undefined
    const hunk = target.hunkIndex === undefined ? undefined : file.hunks[target.hunkIndex]
    const lines = hunk?.lines ?? file.lines
    return {
      document,
      indexes: lines.flatMap((line) => {
        const index = document.lines.indexOf(line)
        return index >= 0 && (line.kind === "addition" || line.kind === "deletion") ? [index] : []
      }),
    }
  }

  private handleBranchDialogKey(key: KeyEvent): boolean {
    const dialog = this.commitDialog
    const context = this.branchDialogContext
    if (dialog === undefined || context === undefined) return false
    const result = commitDialogKey(dialog.state, key)
    if (result.result?.kind === "cancelled") {
      this.commitDialog = undefined
      this.branchDialogContext = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.clearDiscardState()
      this.root.requestRender()
      return true
    }
    if (result.result?.kind === "confirmed") {
      const message = result.result.message
      const operation = context.mode === "branch-create"
        ? this.onCreateBranch === undefined ? undefined : () => this.onCreateBranch!(context.startPoint, message)
        : this.onRenameBranch === undefined ? undefined : () => this.onRenameBranch!(context.branch, message)
      if (operation === undefined) return true
      this.commitDialog = undefined
      this.branchDialogContext = undefined
      this.runUiMutation(operation)
      return true
    }
    const next = result
    const nextDialog = new CommitDialog(next.state.mode, next.state.message)
    nextDialog.setError(next.state.error)
    this.commitDialog = nextDialog
    this.panes.branches.box.bottomTitle = renderCommitDialog(nextDialog.state)
    this.root.requestRender()
    return true
  }

  private handleStashDialogKey(key: KeyEvent): boolean {
    const dialog = this.commitDialog
    if (dialog === undefined || dialog.state.mode !== "stash") return false
    const result = commitDialogKey(dialog.state, key)
    if (result.result?.kind === "cancelled") {
      this.commitDialog = undefined
      this.panes.main.box.bottomTitle = undefined
      this.root.requestRender()
      return true
    }
    if (result.result?.kind === "confirmed") {
      if (this.onCreateStash === undefined) return true
      this.mutationInFlight = true
      void this.onCreateStash(result.result.message, this.stashIncludeUntracked).then(() => {
        if (this.commitDialog === dialog) {
          this.commitDialog = undefined
          this.panes.main.box.bottomTitle = undefined
        }
      }).catch((error: unknown) => {
        dialog.setError(error instanceof Error ? error.message : String(error))
        this.panes.main.box.bottomTitle = `${renderCommitDialog(dialog.state)}\nInclude untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`
      }).finally(() => {
        this.mutationInFlight = false
        this.root.requestRender()
      })
      return true
    }
    const next = commitDialogKey(dialog.state, key)
    this.commitDialog = new CommitDialog("stash", next.state.message)
    this.commitDialog.setError(next.state.error)
    this.panes.main.box.bottomTitle = `${renderCommitDialog(this.commitDialog.state)}\nInclude untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`
    this.root.requestRender()
    return true
  }

  private invalidateRemoteCheckout(): void {
    this.remoteCheckoutGeneration += 1
    this.pendingRemoteMismatch = undefined
  }

  private runRemoteCheckout(selection: RemoteBranchSelection, confirmedMismatch: boolean): void {
    if (this.onCheckoutRemoteTracking === undefined || this.mutationInFlight) return
    const requestGeneration = ++this.remoteCheckoutGeneration
    const requestFocus = this.focusManager.active
    const requestActiveTab = this.branchesPanel.activeTab
    const requestChild = this.branchesPanel.child
    const requestSelectedId = (this.branchesPanel.child?.view ?? this.branchesPanel.views[this.branchesPanel.activeTab])?.selectedId
    const requestFilter = this.branchFilter
    const requestFilterActive = this.branchFilterActive
    const requestTarget = JSON.stringify(this.model.reviewTarget)
    this.mutationInFlight = true
    this.remoteCheckoutInFlight = true
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    const isCurrent = (): boolean => {
      if (requestGeneration !== this.remoteCheckoutGeneration) return false
      if (this.focusManager.active !== requestFocus || this.branchesPanel.activeTab !== requestActiveTab ||
        (this.branchesPanel.child?.value.remote ?? null) !== (requestChild?.value.remote ?? null) ||
        (this.branchesPanel.child?.view.selectedId ?? this.branchesPanel.views[this.branchesPanel.activeTab]?.selectedId) !== requestSelectedId ||
        this.branchFilter !== requestFilter || this.branchFilterActive !== requestFilterActive ||
        JSON.stringify(this.model.reviewTarget) !== requestTarget) return false
      return requestSelectedId === `remote-branch:${selection.ref}`
    }
    void this.onCheckoutRemoteTracking(selection, confirmedMismatch).then((result) => {
      if (!isCurrent()) return
      if (result?.kind === "mismatch") {
        this.pendingRemoteMismatch = { selection, message: result.message }
        const confirmation = remoteTrackingMismatchConfirmation(result.message)
        this.panes.branches.box.bottomTitle =
          `${confirmation.message} Press ${capitalizeKeyName(confirmation.confirmKey)} to confirm or ${capitalizeKeyName(confirmation.cancelKey)} to cancel.`
      } else {
        this.pendingRemoteMismatch = undefined
        this.panes.branches.box.bottomTitle = undefined
      }
      this.root.requestRender()
    }).catch((error: unknown) => {
      if (!isCurrent()) return
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    }).finally(() => {
      this.mutationInFlight = false
      this.remoteCheckoutInFlight = false
      if (requestGeneration === this.remoteCheckoutGeneration) {
        this.clearDiscardState()
      }
    })
  }
  private openCommitDialog(mode: "commit" | "amend" | "stash", initialMessage: string): void {
    this.commitDialog = new CommitDialog(mode, initialMessage)
    this.panes.main.box.bottomTitle = renderCommitDialog(this.commitDialog.state)
    this.root.requestRender()
  }
  private openBranchDialog(mode: "branch-create" | "branch-rename", initialMessage: string): void {
    this.commitDialog = new CommitDialog(mode, initialMessage)
    this.panes.branches.box.bottomTitle = renderCommitDialog(this.commitDialog.state)
    this.root.requestRender()
  }

  private openAmendDialog(): void {
    if (this.onCurrentCommitMessage === undefined) return
    this.mutationInFlight = true
    void this.onCurrentCommitMessage().then((message) => {
      this.openCommitDialog("amend", message)
    }).catch((error: unknown) => {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    }).finally(() => {
      this.mutationInFlight = false
    })
  }

  private handleCommitDialogKey(key: KeyEvent): boolean {
    const dialog = this.commitDialog
    if (dialog === undefined) return false
    const result = commitDialogKey(dialog.state, key)
    if (result.result?.kind === "cancelled") {
      this.commitDialog = undefined
      this.panes.main.box.bottomTitle = undefined
      this.root.requestRender()
      return true
    }
    if (result.result?.kind === "confirmed") {
      const message = result.result.message
      const operation = dialog.state.mode === "amend" ? this.onAmendMessage : this.onCommitMessage
      if (operation === undefined) return true
      this.mutationInFlight = true
      void operation(message).then(() => {
        if (this.commitDialog === dialog) {
          this.commitDialog = undefined
          this.panes.main.box.bottomTitle = undefined
        }
      }).catch((error: unknown) => {
        dialog.setError(error instanceof Error ? error.message : String(error))
        this.panes.main.box.bottomTitle = renderCommitDialog(dialog.state)
      }).finally(() => {
        this.mutationInFlight = false
        this.root.requestRender()
      })
      return true
    }
    const next = result
    const nextDialog = new CommitDialog(next.state.mode, next.state.message)
    nextDialog.setError(next.state.error)
    this.commitDialog = nextDialog
    this.panes.main.box.bottomTitle = renderCommitDialog(nextDialog.state)
    this.root.requestRender()
    return true
  }

  private runUiMutation(operation: () => Promise<void> | undefined): void {
    if (this.mutationInFlight) return
    this.mutationInFlight = true
    this.clearDiscardState()
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    const promise = operation()
    if (promise === undefined) {
      this.mutationInFlight = false
      return
    }
    void promise.catch((error: unknown) => {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    }).finally(() => {
      this.mutationInFlight = false
      this.clearDiscardState()
    })
  }

  /** Resolves when the current commits-pane preview request (if any) has settled. Exposed for
   *  tests: preview loads run outside the mutation queue, so they have no other completion signal. */
  whenPreviewSettled(): Promise<void> {
    return this.previewInflight
  }

  get commitsContextKind(): "commits" | "commit-files" {
    return this.commitsPanel.child !== undefined ? "commit-files" : "commits"
  }

  get mainContent(): MainPaneContent | undefined {
    return this.installedMainContent
  }

  get hasMainSelection(): boolean {
    const view = this.panes.main.text as unknown as { hasSelection?: () => boolean }
    return typeof view.hasSelection === "function" ? view.hasSelection() : false
  }

  installMainContent(content: MainPaneContent): void {
    this.installedMainContent = content
    installMainPaneContent(this.panes.main, content, this.geometry.tooSmall)
    this.root.requestRender()
  }

  private refreshCommitsPanel(model: AppModel): void {
    const commits = model.commits ?? []
    const rows = commits.map((c) => ({ id: c.oid, columns: [{ text: c.subject, priority: 2 }] }))
    let panel = this.commitsPanel
    panel = { ...panel, views: { ...panel.views, commits: setListRows(panel.views.commits, rows) } }
    if (panel.child !== undefined) {
      const details = panel.child.value.details
      const fileRows = commitFileRows(details)
      const displayRows = fileRows.length === 0 ? [{ kind: "message" as const, text: "No files" }] : undefined
      const listRows = fileRows.length === 0 ? [] : fileRows
      const nextView = setListRows(panel.child.view, listRows, displayRows)
      panel = { ...panel, child: { ...panel.child, view: nextView } }
    }
    this.commitsPanel = panel
  }

  private renderCommitsPane(): void {
    const pane = this.panes.commits
    const state = this.commitsPanel.child?.view ?? this.commitsPanel.views.commits
    if (state === undefined) {
      pane.update("")
      return
    }
    const width = this.geometry.windows.commits !== undefined ? Math.max(10, widthOf(this.geometry.windows.commits) - 2) : 80
    const focused = this.focusManager.active === "commits"
    const content = renderListRows(state, focused, width)
    pane.update(content)
    pane.syncScrollbar()
  }

  private installInitialMainContent(model: AppModel): void {
    const content = this.presentFilesContent(model)
    this.mainGate.installSynchronous(content)
  }

  private presentFilesContent(model: AppModel): MainPaneContent {
    const selected = model.files[this.fileCursorIndex]
    const stableId = selected?.path ?? "empty"
    const label = selected?.path ?? "Files"
    const text = model.rawPatchSections.length > 0 ? model.rawPatchSections.map((p) => p.text).join("") : model.patches.map((p) => p.text).join("")
    if (text.length > 0) {
      try {
        const doc = parseDiff(text)
        return { source: "files", stableId, label, document: doc }
      } catch {}
    }
    return { source: "files", stableId, label, plainText: text.length > 0 ? text : "No patch loaded" }
  }

  private presentCommitContent(details: CommitDetails): MainPaneContent {
    return {
      source: "commit",
      stableId: details.oid,
      label: details.shortOid,
      ...(details.preamble === undefined ? {} : { preamble: details.preamble }),
      document: details.document,
    }
  }
  private presentCommitFileContent(oid: string, selectedId: string, doc: DiffDocument): MainPaneContent {
    const label = selectedId.split("\u0000")[0]!
    return { source: "commit-file", stableId: `${oid}\0${selectedId}`, label, document: doc }
  }
  private syncPreviewForFocus(focus: FocusId): void {
    if (focus === "commits") {
      if (this.commitsPanel.child !== undefined) {
        const child = this.commitsPanel.child
        const view = child.view
        const selectedId = view.selectedId
        if (selectedId === undefined) {
          // empty commit: retain parent commit preview
          const details = child.value.details
          const content = this.presentCommitContent(details)
          this.mainGate.installSynchronous(content)
          return
        }
        const filePath = selectedId.split("\u0000")[0]!
        const oid = child.value.oid
        if (this.loadCommitFileInspection !== undefined) {
          const stableId = `${oid}\0${selectedId}`
          const load = (): Promise<DiffDocument> => this.loadCommitFileInspection!(oid, filePath)
          const present = (doc: DiffDocument): MainPaneContent => this.presentCommitFileContent(oid, selectedId, doc)
          const promise = this.mainGate.request("commit-file", stableId, load, present)
          this.previewInflight = promise.catch(() => {})
        }
        return
      }
      const state = this.commitsPanel.views.commits
      if (state === undefined || state.selectedId === undefined) {
        this.installInitialMainContent(this.model)
        return
      }
      const oid = state.selectedId
      if (this.loadCommitInspection !== undefined) {
        const load = (): Promise<CommitDetails> => this.loadCommitInspection!(oid)
        const present = (details: CommitDetails): MainPaneContent => this.presentCommitContent(details)
        const promise = this.mainGate.request("commit", oid, load, present)
        this.previewInflight = promise.catch(() => {})
      }
      return
    }
    if (focus === "files") {
      const content = this.presentFilesContent(this.model)
      this.mainGate.installSynchronous(content)
      return
    }
    if (focus === "branches") {
      const panel = this.branchesPanel
      if (panel.child !== undefined) {
        const content: MainPaneContent = { source: "remote-branch", stableId: panel.child.view.selectedId ?? panel.child.value.remote, label: panel.child.value.remote, plainText: `Remote ${panel.child.value.remote}` }
        this.mainGate.installSynchronous(content)
        return
      }
      const active = panel.activeTab
      const view = panel.views[active]
      const selectedId = view?.selectedId ?? active
      let source: MainPaneContent["source"] = "local-branch"
      if (active === "remotes") source = "remote"
      else if (active === "tags") source = "tag"
      if (active === "tags" && selectedId.startsWith("tag:") && this.loadTagInspection !== undefined) {
        const ref = selectedId.slice("tag:".length)
        const tag = this.model.tags?.find((t) => t.ref === ref)
        if (tag !== undefined) {
          const load = (): Promise<import("../domain/tag").TagPreview> => this.loadTagInspection!(tag)
          const present = (preview: import("../domain/tag").TagPreview): MainPaneContent => ({
            source: "tag",
            stableId: ref,
            label: preview.name,
            plainText: `${preview.name} ${preview.kind} ${preview.targetOid.slice(0, 7)} ${preview.subject ?? ""}`,
          })
          const promise = this.mainGate.request("tag", ref, load, present)
          this.previewInflight = promise.catch(() => {})
          return
        }
      }
      const content: MainPaneContent = { source, stableId: selectedId, label: selectedId, plainText: `${source} ${selectedId}` }
      this.mainGate.installSynchronous(content)
      return
    }
    if (focus === "stash") {
      const stashes = this.model.stashes ?? []
      const idx = stashCursorIndex(this.panes.stash)
      const entry = stashes[idx]
      const stableId = entry?.ref ?? "stash-empty"
      const content: MainPaneContent = { source: "stash", stableId, label: entry?.ref ?? "Stash", plainText: entry !== undefined ? `${entry.ref} ${entry.message}` : "No stashes" }
      this.mainGate.installSynchronous(content)
      return
    }
    if (focus === "main") {
      const content = this.presentFilesContent(this.model)
      this.mainGate.installSynchronous(content)
      return
    }
    // for status, etc., keep current
  }
  private moveMainCursor(direction: "next" | "previous"): void {
    const pane = this.panes.main
    const document = getMainDocument(pane)
    if (!document) {
      pane.box.bottomTitle = "No patch loaded"
      this.root.requestRender()
      return
    }
    const target = moveMainCursor(document, getMainCursorTarget(pane), direction)
    if (!target) {
      pane.box.bottomTitle = "No file target"
      this.root.requestRender()
      return
    }
    setMainCursorTarget(pane, target)
    const targetLine = mainCursorTargetLine(document, target)
    if (targetLine !== undefined) this.revealListRow("main", pane, targetLine)
    this.clearDiscardState()
    const location = target.hunkIndex === undefined ? "file" : `hunk ${target.hunkIndex + 1}`
    pane.box.bottomTitle = `Cursor file ${target.fileIndex + 1}, ${location}`
    this.root.requestRender()
  }
  private copyMainMode(mode: CopyMode): void {
    const pane = this.panes.main
    const document = getMainDocument(pane)
    if (!document) {
      pane.box.bottomTitle = "No text selected"
      this.root.requestRender()
      return
    }
    const nativeRange = pane.text.getSelection()
    let selection = nativeRange ? selectionFromRenderable(document, nativeRange, pane.text.getSelectedText()) : undefined
    if (!selection && (mode === "hunk" || mode === "file")) {
      const target = getMainCursorTarget(pane)
      if (target) {
        selection = {
          valid: true,
          startUtf16: 0,
          endUtf16: 0,
          fileIndex: target.fileIndex,
          ...(target.hunkIndex === undefined ? {} : { hunkIndex: target.hunkIndex }),
          active: false,
        }
      }
    }
    const text = copySelection(document, selection, mode)
    if (selection && !selection.valid) {
      pane.box.bottomTitle = `Selection rejected: ${selection.reason ?? "native/display mismatch"}`
      this.root.requestRender()
      return
    }
    pane.box.bottomTitle = formatCopyResult(this.clipboard.copy(text))
    this.root.requestRender()
  }

  private isOverVerticalSplitter(x: number, y: number): boolean {
    const win = this.geometry.windows.vsplit
    if (win === undefined) return false
    return x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1
  }
  private isOverHorizontalSplitter(x: number, y: number): boolean {
    const win = this.geometry.windows.hsplit
    if (win === undefined) return false
    return x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1
  }
  private hitTestScrollbar(x: number, y: number): FocusId | undefined {
    const check = (id: FocusId, winName: WindowName): boolean => {
      const win = this.geometry.windows[winName]
      if (win === undefined) return false
      const pane: PaneHandle | CommandLogPaneHandle | undefined = id === "command-log" ? this.commandLog : (this.panes as Record<string, PaneHandle>)[id]
      if (!pane) return false
      const bar = paneScrollbar(pane.text)
      if (!bar || !bar.visible) return false
      const barX = win.x1 - 1
      const barY0 = win.y0 + 1
      const barY1 = win.y1 - 1
      return x === barX && y >= barY0 && y <= barY1
    }
    const candidates: Array<[FocusId, WindowName]> = [
      ["main", "main"],
      ["status", "status"],
      ["files", "files"],
      ["branches", "branches"],
      ["commits", "commits"],
      ["stash", "stash"],
      ["command-log", "log"],
    ]
    for (const [id, winName] of candidates) {
      if (check(id, winName)) return id
    }
    return undefined
  }
  private findPaneAtPoint(x: number, y: number): { id: FocusId; winName: WindowName } | undefined {
    const windows = this.geometry.windows as unknown as Record<string, { x0: number; y0: number; x1: number; y1: number } | undefined>
    const order: Array<[FocusId, WindowName]> = [
      ["main", "main"],
      ["status", "status"],
      ["files", "files"],
      ["branches", "branches"],
      ["commits", "commits"],
      ["stash", "stash"],
      ["command-log", "log"],
    ]
    for (const [id, winName] of order) {
      const win = windows[winName]
      if (win === undefined) continue
      if (x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1) return { id, winName }
    }
    return undefined
  }
  private selectRowForPane(paneId: FocusId, stableId: string): void {
    if (paneId === "commits") {
      const panel = this.commitsPanel
      if (panel.child !== undefined) {
        const nextView = selectListRow(panel.child.view, stableId)
        if (nextView !== panel.child.view) {
          this.commitsPanel = { ...panel, child: { ...panel.child, view: nextView } }
          this.renderCommitsPane()
          this.revealListRow("commits", this.panes.commits, nextView.selectedIndex)
          this.syncPreviewForFocus("commits")
        }
      } else {
        const view = panel.views.commits
        if (!view) return
        const nextView = selectListRow(view, stableId)
        if (nextView !== view) {
          this.commitsPanel = { ...panel, views: { ...panel.views, commits: nextView } }
          this.renderCommitsPane()
          this.revealListRow("commits", this.panes.commits, nextView.selectedIndex)
          this.syncPreviewForFocus("commits")
        }
      }
      this.root.requestRender()
      return
    }
    if (paneId === "branches") {
      const panel = this.branchesPanel
      if (panel.child !== undefined) {
        const nextView = selectListRow(panel.child.view, stableId)
        if (nextView !== panel.child.view) {
          this.branchesPanel = { ...panel, child: { ...panel.child, view: nextView } }
          this.renderBranchesPane()
          this.revealListRow("branches", this.panes.branches, nextView.selectedIndex)
          this.syncPreviewForFocus("branches")
        }
      } else {
        const active = panel.activeTab
        const view = panel.views[active]
        if (!view) return
        const nextView = selectListRow(view, stableId)
        if (nextView !== view) {
          this.branchesPanel = { ...panel, views: { ...panel.views, [active]: nextView } }
          this.renderBranchesPane()
          this.revealListRow("branches", this.panes.branches, nextView.selectedIndex)
          this.syncPreviewForFocus("branches")
        }
      }
      this.root.requestRender()
      return
    }
  }
  private handleDoubleClick(paneId: FocusId): void {
    if (paneId === "commits") {
      if (this.commitsPanel.child !== undefined) {
        this.syncPreviewForFocus("commits")
      } else {
        this.actionCommitDrilldown()
      }
      return
    }
    if (paneId === "branches") {
      this.actionBranchInspect()
      return
    }
    if (paneId === "files") {
      this.actionOpenFile()
      return
    }
    if (paneId === "stash") {
      this.actionStashInspect()
      return
    }
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancelGesture()
    this.root.onMouse = undefined
    this.verticalSplitter.box.onMouseOver = undefined
    this.verticalSplitter.box.onMouseOut = undefined
    this.verticalSplitter.box.onMouseDown = undefined
    this.verticalSplitter.box.onMouseDrag = undefined
    this.horizontalSplitter.box.onMouseOver = undefined
    this.horizontalSplitter.box.onMouseOut = undefined
    this.horizontalSplitter.box.onMouseDown = undefined
    this.horizontalSplitter.box.onMouseDrag = undefined
    for (const pane of Object.values(this.panes)) {
      pane.box.onMouseDown = undefined
      pane.box.onMouseScroll = undefined
    }
    this.panes.main.text.onMouseDown = undefined
    this.commandLog.box.onMouseDown = undefined
    this.commandLog.box.onMouseScroll = undefined
    for (const pane of [...Object.values(this.panes), this.commandLog as unknown as PaneHandle]) {
      const bar = paneScrollbar(pane.text)
      if (bar) {
        bar.onMouseDown = undefined
        bar.onMouseDrag = undefined
        bar.onMouseUp = undefined
      }
    }
    this.renderer.off("resize", this.handleResize)
    this.renderer.keyInput.off("keypress", this.handleKey)
    this.root.destroyRecursively()
  }

  private installMouseHandlers(): void {
    for (const [splitter] of [[this.verticalSplitter, "vertical"], [this.horizontalSplitter, "horizontal"]] as const) {
      splitter.box.onMouseOver = () => splitter.setHovered(true)
      splitter.box.onMouseOut = () => splitter.setHovered(false)
      splitter.box.onMouseDown = undefined
      splitter.box.onMouseDrag = undefined
    }
    for (const pane of Object.values(this.panes)) {
      pane.box.onMouseDown = undefined
      pane.box.onMouseScroll = undefined
    }
    this.panes.main.text.onMouseDown = undefined
    this.commandLog.box.onMouseDown = undefined
    this.commandLog.box.onMouseScroll = undefined
    const allPanes: Array<PaneHandle | CommandLogPaneHandle> = [...Object.values(this.panes), this.commandLog]
    for (const pane of allPanes) {
      const typedPane = pane as PaneHandle
      const bar = paneScrollbar(typedPane.text)
      if (!bar) continue
      bar.onMouseDown = (event: MouseEvent) => {
        this.pendingClick = undefined
        this.lastSplitterPress = undefined
        this.gestureOwner = { kind: "scrollbar", paneId: typedPane.id }
        event.stopPropagation()
      }
      bar.onMouseDrag = (event: MouseEvent) => {
        if (this.gestureOwner?.kind === "scrollbar" && this.gestureOwner.paneId === typedPane.id) event.stopPropagation()
      }
      bar.onMouseUp = (event: MouseEvent) => {
        if (this.gestureOwner?.kind === "scrollbar" && this.gestureOwner.paneId === typedPane.id) event.stopPropagation()
      }
    }
    this.root.onMouse = (event: MouseEvent) => {
      const scrollInfo = (event as unknown as { scroll?: { direction: string; delta: number } }).scroll
      if ((event.type as string) === "scroll") {
        this.pendingClick = undefined
        this.lastSplitterPress = undefined
        if (this.isOverVerticalSplitter(event.x, event.y) || this.isOverHorizontalSplitter(event.x, event.y)) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        const hit = this.findPaneAtPoint(event.x, event.y)
        if (hit) {
          const pane = hit.id === "command-log" ? this.commandLog as unknown as PaneHandle : (this.panes as Record<string, PaneHandle>)[hit.id]
          if (pane) {
            const direction = scrollInfo?.direction
            const signed = direction === "up" ? -1 : direction === "down" ? 1 : 0
            if (signed !== 0) {
              const delta = Math.max(1, scrollInfo?.delta ?? 1)
              pane.scrollBy(signed * 2 * delta)
            }
          }
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (this.gestureOwner !== undefined) {
        const owner = this.gestureOwner
        if (owner.kind === "vertical-splitter") {
          if (event.type === "drag") {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            this.sidePanelRatio = ratioForMouseX(this.geometry, event.x)
            this.recomputeLayout()
            this.notifyGeometry()
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.type === "up") {
            this.gestureOwner = undefined
            this.activeSplitterDrag = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          event.stopPropagation()
          return
        }
        if (owner.kind === "horizontal-splitter") {
          if (event.type === "drag") {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            this.logHeight = logHeightForMouseY(this.geometry, event.y)
            this.recomputeLayout()
            this.notifyGeometry()
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.type === "up") {
            this.gestureOwner = undefined
            this.activeSplitterDrag = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          event.stopPropagation()
          return
        }
        if (owner.kind === "scrollbar") {
          const barPane = owner.paneId === "command-log" ? this.commandLog as unknown as PaneHandle : (this.panes as Record<string, PaneHandle>)[owner.paneId]
          const bar = barPane ? paneScrollbar(barPane.text) : undefined
          const win = (this.geometry.windows as Record<string, { x0:number; y0:number; x1:number; y1:number } | undefined>)[owner.paneId === "command-log" ? "log" : owner.paneId]
          if (event.type === "drag") {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            if (bar && win && barPane) {
              const barScreenY = (bar as unknown as { screenY:number }).screenY
              const barHeight = (bar as unknown as { height:number }).height as number
              const trackStart = Number.isFinite(barScreenY) ? barScreenY : win.y0 + 1
              const trackSize = Number.isFinite(barHeight) && barHeight > 0 ? barHeight : Math.max(1, win.y1 - win.y0 - 1)
              const relative = event.y - trackStart
              const clamped = Math.max(0, Math.min(trackSize, relative))
              const ratio = trackSize === 0 ? 0 : clamped / trackSize
              const range = Math.max(0, bar.scrollSize - bar.viewportSize)
              const newPos = Math.round(ratio * range)
              barPane.scrollTo(newPos)
            }
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.type === "up") {
            if (bar && win && barPane) {
              const barScreenY = (bar as unknown as { screenY:number }).screenY
              const barHeight = (bar as unknown as { height:number }).height as number
              const trackStart = Number.isFinite(barScreenY) ? barScreenY : win.y0 + 1
              const trackSize = Number.isFinite(barHeight) && barHeight > 0 ? barHeight : Math.max(1, win.y1 - win.y0 - 1)
              const relative = event.y - trackStart
              const clamped = Math.max(0, Math.min(trackSize, relative))
              const ratio = trackSize === 0 ? 0 : clamped / trackSize
              const range = Math.max(0, bar.scrollSize - bar.viewportSize)
              const newPos = Math.round(ratio * range)
              barPane.scrollTo(newPos)
            }
            this.gestureOwner = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          event.stopPropagation()
          return
        }
        if (owner.kind === "main-selection") {
          if (event.type === "drag") {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            event.stopPropagation()
            return
          }
          if (event.type === "up") {
            this.gestureOwner = undefined
            event.stopPropagation()
            return
          }
          event.stopPropagation()
          return
        }
      }
      if (event.type === "down") {
        if (this.modalInputActive()) {
          this.cancelGesture()
          return
        }
        const scrollbarHit = this.hitTestScrollbar(event.x, event.y)
        if (scrollbarHit !== undefined) {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          this.gestureOwner = { kind: "scrollbar", paneId: scrollbarHit }
          const barPane = scrollbarHit === "command-log" ? this.commandLog as unknown as PaneHandle : (this.panes as Record<string, PaneHandle>)[scrollbarHit]
          const bar = barPane ? paneScrollbar(barPane.text) : undefined
          const win = (this.geometry.windows as Record<string, { x0:number; y0:number; x1:number; y1:number } | undefined>)[scrollbarHit === "command-log" ? "log" : scrollbarHit]
          if (bar && win && barPane) {
            const barScreenY = (bar as unknown as { screenY:number }).screenY
            const barHeight = (bar as unknown as { height:number }).height as number
            const trackStart = Number.isFinite(barScreenY) ? barScreenY : win.y0 + 1
            const trackSize = Number.isFinite(barHeight) && barHeight > 0 ? barHeight : Math.max(1, win.y1 - win.y0 - 1)
            const relative = event.y - trackStart
            const clamped = Math.max(0, Math.min(trackSize, relative))
            const ratio = trackSize === 0 ? 0 : clamped / trackSize
            const range = Math.max(0, bar.scrollSize - bar.viewportSize)
            const newPos = Math.round(ratio * range)
            barPane.scrollTo(newPos)
          }
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (this.isOverVerticalSplitter(event.x, event.y)) {
          this.pendingClick = undefined
          this.gestureOwner = { kind: "vertical-splitter" }
          this.activeSplitterDrag = "vertical"
          const previous = this.lastSplitterPress
          const now = Date.now()
          this.lastSplitterPress = { axis: "vertical", x: event.x, y: event.y, at: now }
          const isDouble = previous !== undefined && previous.axis === "vertical" && now - previous.at <= DOUBLE_CLICK_MS && Math.abs(previous.x - event.x) <= 1 && Math.abs(previous.y - event.y) <= 1
          if (isDouble) {
            this.lastSplitterPress = undefined
            this.gestureOwner = undefined
            this.activeSplitterDrag = undefined
            this.toggleSideCollapsed()
          }
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (this.isOverHorizontalSplitter(event.x, event.y)) {
          this.pendingClick = undefined
          this.gestureOwner = { kind: "horizontal-splitter" }
          this.activeSplitterDrag = "horizontal"
          const previous = this.lastSplitterPress
          const now = Date.now()
          this.lastSplitterPress = { axis: "horizontal", x: event.x, y: event.y, at: now }
          const isDouble = previous !== undefined && previous.axis === "horizontal" && now - previous.at <= DOUBLE_CLICK_MS && Math.abs(previous.x - event.x) <= 1 && Math.abs(previous.y - event.y) <= 1
          if (isDouble) {
            this.lastSplitterPress = undefined
            this.gestureOwner = undefined
            this.activeSplitterDrag = undefined
            this.toggleCommandLog()
          }
          event.preventDefault()
          event.stopPropagation()
          return
        }
        const hit = this.findPaneAtPoint(event.x, event.y)
        if (!hit) {
          this.pendingClick = undefined
          return
        }
        const paneId = hit.id
        if (paneId === "main") {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          this.gestureOwner = { kind: "main-selection" }
          if (this.focusManager.active !== "main") this.focusManager.focus("main")
          this.clearDiscardState()
          event.stopPropagation()
          return
        }
        if (paneId === "command-log") {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          if (this.focusManager.active !== "command-log") this.focusManager.focus("command-log")
          event.stopPropagation()
          event.preventDefault()
          return
        }
        const geometry = this.paneTextGeometry(paneId)
        if (!geometry) {
          this.pendingClick = undefined
          if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
          event.stopPropagation()
          event.preventDefault()
          return
        }
        let listState: ListState | undefined
        let viewIdForDouble: string = paneId as string
        if (paneId === "commits") {
          const panel = this.commitsPanel
          if (panel.child !== undefined) {
            listState = panel.child.view
            viewIdForDouble = "commit-files"
          } else {
            listState = panel.views.commits
            viewIdForDouble = "commits"
          }
        } else if (paneId === "branches") {
          const panel = this.branchesPanel
          if (panel.child !== undefined) {
            listState = panel.child.view
            viewIdForDouble = `branches-child:${panel.child.value.remote}`
          } else {
            listState = panel.views[panel.activeTab]
            viewIdForDouble = `branches:${panel.activeTab}`
          }
        }
        if (listState) {
          const pane = (this.panes as Record<string, PaneHandle>)[paneId]
          if (!pane) {
            this.pendingClick = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          const viewport = { screenX: geometry.screenX, screenY: geometry.screenY, width: geometry.width, height: geometry.height, scrollY: pane.text.scrollY }
          let row = listRowAtPoint(listState, viewport, event.x, event.y)
          if (!row) {
            const clampedX = Math.max(viewport.screenX, Math.min(viewport.screenX + viewport.width - 1, event.x))
            let clampedY = event.y
            if (clampedY < viewport.screenY) clampedY = viewport.screenY
            if (clampedY >= viewport.screenY + viewport.height) clampedY = viewport.screenY + viewport.height - 1
            if (clampedX !== event.x || clampedY !== event.y) row = listRowAtPoint(listState, viewport, clampedX, clampedY)
          }
          if (row) {
            const stableId = row.id
            const now = Date.now()
            const pending = this.pendingClick
            const isDouble = pending !== undefined && pending.viewId === viewIdForDouble && pending.stableId === stableId && now - pending.at <= DOUBLE_CLICK_MS && Math.abs(pending.x - event.x) <= 1 && Math.abs(pending.y - event.y) <= 1
            if (isDouble) {
              this.pendingClick = undefined
              this.lastSplitterPress = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              this.selectRowForPane(paneId, stableId)
              event.preventDefault()
              event.stopPropagation()
              this.handleDoubleClick(paneId)
              return
            }
            this.pendingClick = { viewId: viewIdForDouble, stableId, x: event.x, y: event.y, at: now }
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            this.selectRowForPane(paneId, stableId)
            event.preventDefault()
            event.stopPropagation()
            return
          } else {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        if (paneId === "files") {
          const pane = this.panes.files
          const offset = event.y - geometry.screenY
          const clampedOffset = Math.max(0, Math.min(geometry.height - 1, offset))
          const rowIndex = pane.text.scrollY + clampedOffset
          const withinY = event.y >= geometry.screenY && event.y < geometry.screenY + geometry.height
          if (withinY && rowIndex >= 0 && rowIndex < this.model.files.length) {
            const file = this.model.files[rowIndex]
            if (!file) {
              this.pendingClick = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              event.preventDefault()
              event.stopPropagation()
              return
            }
            const stableId = file.path
            const now = Date.now()
            const pending = this.pendingClick
            const isDouble = pending !== undefined && pending.viewId === "files" && pending.stableId === stableId && now - pending.at <= DOUBLE_CLICK_MS && Math.abs(pending.x - event.x) <= 1 && Math.abs(pending.y - event.y) <= 1
            if (isDouble) {
              this.pendingClick = undefined
              this.lastSplitterPress = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              this.fileCursorIndex = rowIndex
              this.revealListRow("files", pane, rowIndex)
              this.panes.files.box.bottomTitle = file.path
              this.onSelectFile?.(file.path)
              const content = this.presentFilesContent(this.model)
              this.mainGate.installSynchronous(content)
              this.root.requestRender()
              event.preventDefault()
              event.stopPropagation()
              this.actionOpenFile()
              return
            }
            this.pendingClick = { viewId: "files", stableId, x: event.x, y: event.y, at: now }
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            this.fileCursorIndex = rowIndex
            this.panes.files.box.bottomTitle = file.path
            this.onSelectFile?.(file.path)
            this.revealListRow("files", pane, rowIndex)
            const content = this.presentFilesContent(this.model)
            this.mainGate.installSynchronous(content)
            this.root.requestRender()
            event.preventDefault()
            event.stopPropagation()
            return
          } else {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        if (paneId === "stash") {
          const pane = this.panes.stash
          const offset = event.y - geometry.screenY
          const clampedOffset = Math.max(0, Math.min(geometry.height - 1, offset))
          const rowIndex = pane.text.scrollY + clampedOffset
          const stashes = this.model.stashes ?? []
          const withinY = event.y >= geometry.screenY && event.y < geometry.screenY + geometry.height
          if (withinY && rowIndex >= 0 && rowIndex < stashes.length) {
            const stash = stashes[rowIndex]
            if (!stash) {
              this.pendingClick = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              event.preventDefault()
              event.stopPropagation()
              return
            }
            const stableId = stash.oid
            const now = Date.now()
            const pending = this.pendingClick
            const isDouble = pending !== undefined && pending.viewId === "stash" && pending.stableId === stableId && now - pending.at <= DOUBLE_CLICK_MS && Math.abs(pending.x - event.x) <= 1 && Math.abs(pending.y - event.y) <= 1
            if (isDouble) {
              this.pendingClick = undefined
              this.lastSplitterPress = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              updateStashPane(pane, this.model, rowIndex)
              this.revealListRow("stash", pane, rowIndex)
              this.syncPreviewForFocus("stash")
              this.root.requestRender()
              event.preventDefault()
              event.stopPropagation()
              this.actionStashInspect()
              return
            }
            this.pendingClick = { viewId: "stash", stableId, x: event.x, y: event.y, at: now }
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            updateStashPane(pane, this.model, rowIndex)
            this.revealListRow("stash", pane, rowIndex)
            this.syncPreviewForFocus("stash")
            this.root.requestRender()
            event.preventDefault()
            event.stopPropagation()
            return
          } else {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        this.pendingClick = undefined
        this.lastSplitterPress = undefined
        if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.type === "drag") {
        this.pendingClick = undefined
        this.lastSplitterPress = undefined
        return
      }
      if (event.type === "up") {
        return
      }
    }
  }
  applyPersistedGeometry(state: PersistedUiState): void {
    this.sidePanelRatio = state.sidePanelRatio
    this.logHeight = state.commandLogHeight
    this.focusManager.logVisible = state.commandLogVisible
    this.recomputeLayout()
  }

  private notifyGeometry(): void {
    this.onGeometryChange?.({
      sidePanelRatio: this.sidePanelRatio,
      commandLogHeight: this.logHeight,
      commandLogVisible: this.focusManager.logVisible,
    })
  }

  /** Collapse the left region and focus main; a second double click restores both. */
  private toggleSideCollapsed(): void {
    if (this.screenMode === "full" && this.focusManager.active === "main") {
      this.screenMode = "normal"
      const previous = this.focusBeforeCollapse
      this.focusBeforeCollapse = undefined
      if (previous !== undefined) {
        this.focusManager.focus(previous)
        return
      }
      this.recomputeLayout()
      return
    }
    this.focusBeforeCollapse = this.focusManager.active
    this.screenMode = "full"
    this.focusManager.focus("main")
  }

  private toggleCommandLog(): void {
    this.focusManager.handleKey("@")
    this.notifyGeometry()
  }


  private applyFocus(active: FocusId): void {
    for (const pane of Object.values(this.panes)) pane.setFocused(pane.id === active)
    this.commandLog.setFocused(active === "command-log")
  }

  private recomputeLayout(): void {
    this.geometry = computeLayout(
      { width: this.renderer.terminalWidth, height: this.renderer.terminalHeight },
      this.layoutOptions(),
    )
    if (this.gestureOwner?.kind === "vertical-splitter" && this.geometry.windows.vsplit === undefined) this.cancelGesture()
    if (this.gestureOwner?.kind === "horizontal-splitter" && this.geometry.windows.hsplit === undefined) this.cancelGesture()
    if (this.gestureOwner?.kind === "scrollbar") {
      const winName = this.gestureOwner.paneId === "command-log" ? "log" : this.gestureOwner.paneId
      if ((this.geometry.windows as Record<string, unknown>)[winName] === undefined) this.cancelGesture()
      else {
        const pane = this.gestureOwner.paneId === "command-log" ? this.commandLog as unknown as PaneHandle : (this.panes as Record<string, PaneHandle>)[this.gestureOwner.paneId]
        const bar = pane ? paneScrollbar(pane.text) : undefined
        if (!bar || !bar.visible) this.cancelGesture()
      }
    }
    this.applyLayout()
  }

  private layoutOptions(): LayoutRequest {
    return {
      sidePanelRatio: this.sidePanelRatio,
      logHeight: this.logHeight,
      logVisible: this.focusManager.logVisible,
      focus: this.focusManager.active,
      currentSideWindow: this.focusManager.lastSide,
      screenMode: this.screenMode,
      hintsVisible: true,
      statusWidth: this.statusSegmentWidth(),
    }
  }

  /** Width the review-status segment occupies in the bottom row's right-hand window. */
  private statusSegmentWidth(): number {
    return reviewStatusText(this.model).length
  }

  private applyLayout(): void {
    const windows = this.geometry.windows
    const place = (
      renderable: {
        left: number | "auto" | `${number}%` | undefined
        top: number | "auto" | `${number}%` | undefined
        width: number | "auto" | `${number}%` | undefined
        height: number | "auto" | `${number}%` | undefined
        visible: boolean
      },
      name: WindowName,
    ): void => {
      const dimensions = windows[name]
      if (dimensions === undefined) {
        renderable.visible = false
        return
      }
      renderable.left = dimensions.x0
      renderable.top = dimensions.y0
      renderable.width = Math.max(1, widthOf(dimensions))
      renderable.height = Math.max(1, heightOf(dimensions))
      renderable.visible = widthOf(dimensions) > 0 && heightOf(dimensions) > 0
    }

    for (const name of SIDE_WINDOWS) place(this.panes[name].box, name)
    place(this.panes.main.box, "main")
    place(this.commandLog.box, "log")
    place(this.verticalSplitter.box, "vsplit")
    place(this.horizontalSplitter.box, "hsplit")
    const vsplit = windows.vsplit
    if (vsplit !== undefined) this.verticalSplitter.render(widthOf(vsplit), heightOf(vsplit))
    const hsplit = windows.hsplit
    if (hsplit !== undefined) this.horizontalSplitter.render(widthOf(hsplit), heightOf(hsplit))

    const log = windows.log
    if (log !== undefined) {
      this.commandLog.resize(Math.max(1, widthOf(log)), Math.max(1, heightOf(log)))
      this.commandLog.update(this.model.commandLog)
    }
    if (this.installedMainContent !== undefined) {
      installMainPaneContent(this.panes.main, this.installedMainContent, this.geometry.tooSmall)
    }

    place(this.hintsBar.hints, "hints")
    place(this.hintsBar.status, "info")
    const hintsWidth = widthOf(windows.hints)
    this.hintsBar.update(
      hintsWidth === 0 ? "" : this.registry.hintsFor(this.focusManager.active, this.model, this.uiState(), hintsWidth),
      reviewStatusText(this.model),
    )

    const menuHost = windows.main ?? windows.hints
    if (this.menuOpen && menuHost !== undefined) {
      const width = Math.max(20, Math.min(72, widthOf(menuHost) - 4))
      const height = Math.max(6, Math.min(this.geometry.terminalHeight - 4, heightOf(menuHost) - 2))
      this.keybindingMenu.box.left = menuHost.x0 + Math.floor((widthOf(menuHost) - width) / 2)
      this.keybindingMenu.box.top = menuHost.y0 + Math.floor((heightOf(menuHost) - height) / 2)
      this.keybindingMenu.box.width = width
      this.keybindingMenu.box.height = height
      this.keybindingMenu.update(
        this.registry.menuFor(this.focusManager.active, this.model, this.uiState()),
        paneTitleFor(this.focusManager.active),
      )
    }
    this.keybindingMenu.box.visible = this.menuOpen
    this.root.requestRender()
  }
}

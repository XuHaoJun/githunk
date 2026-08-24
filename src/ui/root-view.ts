import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import type { AppModel } from "../app/model"
import type { WorkingTreeScope } from "../domain/review-target"
import {
  computeLayout,
  heightOf,
  resizeCommandLog,
  resizeLeftPane,
  widthOf,
  type LayoutGeometry,
} from "./layout"
import { FocusManager, FOCUS_IDS, type FocusId } from "./focus"
import { indexForStableId } from "../app/filter"
import { createBranchesPane, branchItemId, branchPaneItems, moveBranchesCursor, selectedBranchItem, updateBranchesPane } from "./panes/branches-pane"
import { createCommitsPane, getSelectedCommit, moveCommitsCursor, updateCommitsPane } from "./panes/commits-pane"
import { createCommandLogPane, type CommandLogPaneHandle } from "./panes/command-log-pane"
import { createFilesPane, filesPaneCommitAvailable, updateFilesPane } from "./panes/files-pane"
import { createMainPane, changeLineIndexes, getMainCursorTarget, getMainDocument, mainActionAvailability, mainPaneCommitAvailable, moveMainCursor, setMainCursorTarget, updateMainPane, type MainPaneOverride } from "./panes/main-pane"
import { createStashPane, moveStashCursor, selectedStashEntry, selectedStashItem, updateStashPane } from "./panes/stash-pane"
import { createStatusPane, updateStatusPane } from "./panes/status-pane"
import type { PaneHandle } from "./panes/common"
import { copySelection, selectionFromRenderable } from "../domain/diff/selection"
import type { CopyMode, DiffDocument } from "../domain/diff/document"
import { ClipboardService, formatCopyResult, type ClipboardPort } from "./clipboard"
import { discardConfirmation } from "./confirm-dialog"
import { branchDeleteConfirmation, remoteTrackingMismatchConfirmation } from "./branch-dialogs"
import { COPY_MENU_ITEMS } from "./copy-menu"
import type { CheckoutRemoteTrackingResult, RemoteBranchSelection } from "../git/branches"
import { CommitDialog, commitDialogKey, renderCommitDialog } from "./commit-dialog"
import { FilterInput } from "./filter-input"
import { normalizeKey } from "./keymap"
import { createRegistry, type Action, type UiState } from "./bindings"

export type RootViewOptions = {
  readonly leftWidth?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly onStageFile?: (path: string) => Promise<void>
  readonly onUnstageFile?: (path: string) => Promise<void>
  readonly onDiscardFile?: (path: string, untracked: boolean) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onScopeChange?: (scope: WorkingTreeScope) => Promise<void>
  readonly onModeChange?: (mode: "working-tree" | "branch") => Promise<void>
  readonly onChooseBase?: (baseRef: string) => Promise<void>
  readonly onCancelBase?: () => Promise<void>
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile?: (path: string) => void
  readonly onSelectCommit?: (oid: string) => Promise<void>
  readonly loadCommitPreview?: (oid: string) => Promise<string>
  readonly onSelectCommitFile?: (path: string) => Promise<void>
  readonly onCommitBack?: () => Promise<void>
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

function stackedHeights(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

/** Ring order for the `[` / `]` scope-cycle keys in the main pane. */
const SCOPE_ORDER: readonly WorkingTreeScope[] = ["all", "staged", "unstaged"]

export class RootView {
  readonly renderer: CliRenderer
  readonly root: BoxRenderable
  readonly focusManager = new FocusManager()
  geometry: LayoutGeometry

  private model: AppModel
  private readonly panes: Record<Exclude<FocusId, "command-log">, PaneHandle>
  private readonly commandLog: CommandLogPaneHandle
  private readonly clipboard: ClipboardService
  private readonly verticalSplitter: BoxRenderable
  private readonly horizontalSplitter: BoxRenderable
  private readonly onStageFile: ((path: string) => Promise<void>) | undefined
  private readonly onUnstageFile: ((path: string) => Promise<void>) | undefined
  private readonly onDiscardFile: ((path: string, untracked: boolean) => Promise<void>) | undefined
  private readonly onToggleAllFiles: (() => Promise<void>) | undefined
  private readonly onScopeChange: ((scope: WorkingTreeScope) => Promise<void>) | undefined
  private readonly onModeChange: ((mode: "working-tree" | "branch") => Promise<void>) | undefined
  private readonly onChooseBase: ((baseRef: string) => Promise<void>) | undefined
  private readonly onCancelBase: (() => Promise<void>) | undefined
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private basePickerIndex = 0
  private readonly onSelectFile: ((path: string) => void) | undefined
  private readonly onSelectCommit: ((oid: string) => Promise<void>) | undefined
  private readonly loadCommitPreview: ((oid: string) => Promise<string>) | undefined
  private readonly onSelectCommitFile: ((path: string) => Promise<void>) | undefined
  private readonly onCommitBack: (() => Promise<void>) | undefined
  private readonly onCommitMessage: ((message: string) => Promise<void>) | undefined
  private readonly onAmendMessage: ((message: string) => Promise<void>) | undefined
  private readonly onCurrentCommitMessage: (() => Promise<string>) | undefined
  private commitDialog: CommitDialog | undefined
  private readonly onMarkFocusedFileReviewed: ((path?: string) => Promise<void>) | undefined
  private readonly onRefresh: (() => Promise<void>) | undefined
  private readonly onSwitchLocalBranch: ((branch: string) => Promise<void>) | undefined
  private readonly onCreateBranch: ((startPoint?: string, branchName?: string) => Promise<void>) | undefined
  private readonly onDeleteBranch: ((branch: string, force: boolean) => Promise<void>) | undefined
  private readonly onRenameBranch: ((branch: string, newName?: string) => Promise<void>) | undefined
  private readonly onFetchRemote: ((remote: string) => Promise<void>) | undefined
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
  // lazygit parity: browsing the commits pane previews the selected commit in main without
  // switching the review target; leaving the pane reverts main to the model's own patch.
  private commitPreview: { readonly oid: string; readonly label: string; readonly raw: string } | undefined
  private previewToken = 0
  private previewInflight: Promise<void> = Promise.resolve()
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
  private branchCursorIndex = 0
  private readonly registry = createRegistry()
  private readonly onQuit: (() => void) | undefined
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
    this.onChooseBase = options.onChooseBase
    this.onCancelBase = options.onCancelBase
    this.onUnstageFile = options.onUnstageFile
    this.onDiscardFile = options.onDiscardFile
    this.onToggleAllFiles = options.onToggleAllFiles
    this.onScopeChange = options.onScopeChange
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
    this.onSelectCommitFile = options.onSelectCommitFile
    this.onSelectCommit = options.onSelectCommit
    this.loadCommitPreview = options.loadCommitPreview
    this.onCommitMessage = options.onCommitMessage
    this.onAmendMessage = options.onAmendMessage
    this.onCurrentCommitMessage = options.onCurrentCommitMessage
    this.onCommitBack = options.onCommitBack
    this.onMarkFocusedFileReviewed = options.onMarkFocusedFileReviewed
    this.renderer = renderer
    this.model = model
    this.geometry = computeLayout(
      { width: renderer.terminalWidth, height: renderer.terminalHeight },
      {
        ...options,
        logVisible: options.logVisible ?? false,
      },
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
    this.commandLog = createCommandLogPane(renderer, model.commandLog)
    this.verticalSplitter = new BoxRenderable(renderer, {
      id: "vertical-splitter",
      position: "absolute",
      width: 1,
      height: "100%",
      backgroundColor: "#333333",
    })
    this.verticalSplitter.selectable = false
    this.horizontalSplitter = new BoxRenderable(renderer, {
      id: "horizontal-splitter",
      position: "absolute",
      width: "100%",
      height: 1,
      backgroundColor: "#333333",
    })
    for (const id of FOCUS_IDS) this.root.add(this.panes[id].box)
    this.root.add(this.commandLog.box)
    this.root.add(this.verticalSplitter)
    this.root.add(this.horizontalSplitter)
    renderer.root.add(this.root)

    this.focusManager.onChange = (focus, logVisible) => {
      this.clearDiscardState()
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.pendingStashDrop = undefined
      this.panes.stash.box.bottomTitle = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.filterInput.close()
      this.applyFocus(focus)
      this.geometry = computeLayout(
        { width: renderer.terminalWidth, height: renderer.terminalHeight },
        {
          sidePanelRatio: this.geometry.sidePanelRatio,
          logHeight: this.geometry.logHeight,
          logVisible,
        },
      )
      this.applyLayout()
      this.syncCommitPreview()
    }
    this.handleResize = () => {
      this.geometry = computeLayout(
        { width: renderer.terminalWidth, height: renderer.terminalHeight },
        {
          sidePanelRatio: this.geometry.sidePanelRatio,
          logHeight: this.geometry.logHeight,
          logVisible: this.focusManager.logVisible,
        },
      )
      this.applyLayout()
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
    const branchCount = branchPaneItems(model, this.branchFilter).length
    this.branchCursorIndex = Math.min(this.branchCursorIndex, Math.max(0, branchCount - 1))
    updateBranchesPane(this.panes.branches, model, this.branchCursorIndex, this.branchFilter)
    const focusedIndex = model.focusId === undefined ? -1 : model.files.findIndex((file) => file.path === model.focusId)
    this.fileCursorIndex = focusedIndex >= 0
      ? focusedIndex
      : model.files.length === 0 ? 0 : Math.min(this.fileCursorIndex, model.files.length - 1)
    updateCommitsPane(this.panes.commits, model)
    updateStashPane(this.panes.stash, model)
    updateMainPane(this.panes.main, model, this.geometry.tooSmall, this.activeMainOverride())
    this.syncCommitPreview()
    this.commandLog.update(model.commandLog)
    this.root.requestRender()
  }
  private clearDiscardState(): void {
    this.discardPending = false
    this.pendingDiscardPaths = []
    this.pendingFileDiscard = undefined
  }
  private modalInputActive(): boolean {
    return this.branchFilterActive || this.commitDialog !== undefined || this.copyMenuOpen ||
      this.model.upstreamChoice !== undefined || this.model.basePicker !== undefined ||
      this.pendingBranchDelete !== undefined || this.pendingRemoteMismatch !== undefined ||
      this.pendingStashDrop !== undefined || this.pendingFileDiscard !== undefined || this.discardPending
  }

  /** Whether a mutation (git operation triggered via `runUiMutation`) is currently in flight. */
  get isMutating(): boolean {
    return this.mutationInFlight
  }

  private uiState(): UiState {
    const target = this.model.reviewTarget
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    return {
      focus: this.focusManager.active,
      screenMode: this.geometry.screenMode,
      modal: this.modalInputActive(),
      mainScope: target.kind === "working-tree" ? target.scope : undefined,
      selectedBranchKind: selected?.kind,
      hasSelectedStash: selectedStashEntry(this.panes.stash, this.model) !== undefined,
    }
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
      case "scope-next": this.actionScopeCycle("next"); return
      case "scope-previous": this.actionScopeCycle("previous"); return
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
      // Implemented in Task 6.
      case "screen-mode-next": case "screen-mode-previous":
        return
      // Implemented in Task 7.
      case "keybinding-menu":
        return
      // Implemented in Task 8.
      case "page-next": case "page-previous": case "goto-top": case "goto-bottom":
      case "main-scroll-down": case "main-scroll-up": case "main-scroll-left": case "main-scroll-right":
      case "main-half-page-down": case "main-half-page-up":
      case "hunk-next": case "hunk-previous":
        return
      default: {
        const unhandled: never = action
        return unhandled
      }
    }
  }

  private handleModalKey(key: KeyEvent): void {
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
    const previous = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    const previousId = previous === undefined ? undefined : branchItemId(previous)
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
    const filtered = branchPaneItems(this.model, this.branchFilter)
    this.branchCursorIndex = indexForStableId(filtered, previousId, branchItemId, this.branchCursorIndex)
    updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
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
        return
      }
      case "branches":
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.branchCursorIndex = moveBranchesCursor(this.model, this.branchCursorIndex, direction, this.branchFilter)
        updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
        return
      case "commits":
        moveCommitsCursor(this.panes.commits, this.model, direction)
        this.syncCommitPreview()
        return
      case "stash":
        this.pendingStashDrop = undefined
        this.panes.stash.box.bottomTitle = undefined
        moveStashCursor(this.panes.stash, this.model, direction)
        return
      case "main":
        // j/k move the hunk cursor here (MainCursorTarget is hunk-granular and githunk has
        // no line cursor yet). h/l are bound to hunk-previous/hunk-next in main, not to
        // next/previous, and are no-ops until Task 8 implements hunk navigation.
        this.moveMainCursor(direction)
        return
      default:
        return
    }
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
      if (this.model.reviewTarget.kind === "commit" && this.onSelectCommitFile !== undefined) {
        this.runUiMutation(() => this.onSelectCommitFile!(selected.path))
      } else {
        this.onSelectFile?.(selected.path)
      }
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

  private actionScopeCycle(direction: "next" | "previous"): void {
    if (this.mutationInFlight) {
      this.panes.main.box.bottomTitle = "Mutation in progress; wait for refresh"
      return
    }
    if (this.onScopeChange === undefined) return
    if (this.model.reviewTarget.kind !== "working-tree") return
    this.invalidateRemoteCheckout()
    const index = SCOPE_ORDER.indexOf(this.model.reviewTarget.scope)
    const nextIndex = direction === "next" ? (index + 1) % SCOPE_ORDER.length : (index - 1 + SCOPE_ORDER.length) % SCOPE_ORDER.length
    const scope = SCOPE_ORDER[nextIndex]!
    this.runUiMutation(() => this.onScopeChange!(scope))
  }

  private actionBranchCheckout(): void {
    if (this.mutationInFlight) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    if (selected === undefined) return
    if (selected.kind === "local" && this.onSwitchLocalBranch !== undefined) this.runUiMutation(() => this.onSwitchLocalBranch!(selected.name))
    if (selected.kind === "remote-branch" && this.onCheckoutRemoteTracking !== undefined) {
      this.runRemoteCheckout({ remote: selected.remote, branch: selected.name, ref: selected.ref }, false)
    }
  }

  private actionBranchCreate(): void {
    if (this.mutationInFlight) return
    if (this.onCreateBranch === undefined) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    this.branchDialogContext = { mode: "branch-create", ...(selected?.kind === "local" ? { startPoint: selected.name } : {}) }
    this.openBranchDialog("branch-create", "")
  }

  private actionBranchDelete(force: boolean): void {
    if (this.mutationInFlight) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    if (selected === undefined || this.onDeleteBranch === undefined) return
    const pending = this.pendingBranchDelete
    if (pending?.branch === selected.name && pending.force === force) {
      this.pendingBranchDelete = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onDeleteBranch!(selected.name, force))
    } else {
      this.pendingBranchDelete = { branch: selected.name, force }
      const confirmation = branchDeleteConfirmation(selected.name, force)
      this.panes.branches.box.bottomTitle = `${confirmation.message} Press ${force ? "D" : "d"} again to confirm or Escape to cancel.`
    }
  }

  private actionBranchRename(): void {
    if (this.mutationInFlight) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    if (selected === undefined || this.onRenameBranch === undefined) return
    this.branchDialogContext = { mode: "branch-rename", branch: selected.name }
    this.openBranchDialog("branch-rename", "")
  }

  private actionFetchRemote(): void {
    if (this.mutationInFlight) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    if (selected?.kind === "remote" && this.onFetchRemote !== undefined) this.runUiMutation(() => this.onFetchRemote!(selected.name))
  }

  private actionBranchInspect(): void {
    if (this.mutationInFlight) return
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    if (selected === undefined) return
    if (selected.kind === "local" && this.onInspectBranch !== undefined) {
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onInspectBranch!(selected.name))
    }
    if (selected.kind === "remote" && this.onBrowseRemote !== undefined) {
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onBrowseRemote!(selected.name))
    }
    if (selected.kind === "remote-branch" && this.onInspectBranch !== undefined) {
      const selection = { remote: selected.remote, branch: selected.name, ref: selected.ref }
      if (this.pendingRemoteMismatch !== undefined &&
        this.pendingRemoteMismatch.selection.remote === selection.remote &&
        this.pendingRemoteMismatch.selection.branch === selection.branch &&
        this.pendingRemoteMismatch.selection.ref === selection.ref) {
        this.runRemoteCheckout(selection, true)
      } else {
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.runUiMutation(() => this.onInspectBranch!(selected.ref))
      }
    }
  }

  private actionCommitDrilldown(): void {
    if (this.mutationInFlight) return
    if (this.onSelectCommit === undefined) return
    const selected = getSelectedCommit(this.panes.commits, this.model)
    if (selected === undefined) return
    this.invalidateRemoteCheckout()
    this.runUiMutation(() => this.onSelectCommit!(selected.oid))
    this.focusManager.focus("files")
  }

  private actionCommitBack(): void {
    if (this.onCommitBack === undefined) return
    this.invalidateRemoteCheckout()
    this.runUiMutation(() => this.onCommitBack!())
    if (this.focusManager.active === "main") this.focusManager.focus("commits")
  }

  private actionBack(): void {
    if (this.pendingStashDrop !== undefined) {
      this.pendingStashDrop = undefined
      this.panes.stash.box.bottomTitle = undefined
    }
    if (this.pendingBranchDelete !== undefined || this.pendingRemoteMismatch !== undefined || this.branchFilterActive || this.remoteCheckoutInFlight) {
      this.pendingBranchDelete = undefined
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.filterInput.clear()
      this.filterInput.close()
      this.branchFilter = ""
      updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
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
    const selectedBeforeFilter = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    const selectedId = selectedBeforeFilter === undefined ? undefined : branchItemId(selectedBeforeFilter)
    this.filterInput.open()
    this.branchFilterActive = true
    this.branchFilter = ""
    this.branchCursorIndex = indexForStableId(branchPaneItems(this.model), selectedId, branchItemId, this.branchCursorIndex)
    updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
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
    const requestCursor = this.branchCursorIndex
    const requestFilter = this.branchFilter
    const requestFilterActive = this.branchFilterActive
    const requestTarget = JSON.stringify(this.model.reviewTarget)
    this.mutationInFlight = true
    this.remoteCheckoutInFlight = true
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    const isCurrent = (): boolean => {
      if (requestGeneration !== this.remoteCheckoutGeneration) return false
      if (this.focusManager.active !== requestFocus || this.branchCursorIndex !== requestCursor ||
        this.branchFilter !== requestFilter || this.branchFilterActive !== requestFilterActive ||
        JSON.stringify(this.model.reviewTarget) !== requestTarget) return false
      const current = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
      return current?.kind === "remote-branch" &&
        current.remote === selection.remote &&
        current.name === selection.branch &&
        current.ref === selection.ref
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

  private activeMainOverride(): MainPaneOverride | undefined {
    return this.focusManager.active === "commits" ? this.commitPreview : undefined
  }

  private syncCommitPreview(): void {
    if (this.focusManager.active !== "commits") {
      if (this.commitPreview === undefined) return
      this.previewToken += 1
      this.commitPreview = undefined
      updateMainPane(this.panes.main, this.model, this.geometry.tooSmall)
      this.root.requestRender()
      return
    }
    const selected = getSelectedCommit(this.panes.commits, this.model)
    if (selected === undefined || selected.oid === this.commitPreview?.oid || this.loadCommitPreview === undefined) return
    const token = this.previewToken + 1
    this.previewToken = token
    this.previewInflight = this.loadCommitPreview(selected.oid).then((raw) => {
      if (token !== this.previewToken) return
      this.commitPreview = { oid: selected.oid, label: selected.shortOid, raw }
      updateMainPane(this.panes.main, this.model, this.geometry.tooSmall, this.activeMainOverride())
      this.root.requestRender()
    }).catch((error: unknown) => {
      if (token !== this.previewToken) return
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
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

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.verticalSplitter.onMouseDown = undefined
    this.verticalSplitter.onMouseDrag = undefined
    this.horizontalSplitter.onMouseDown = undefined
    this.horizontalSplitter.onMouseDrag = undefined
    this.renderer.off("resize", this.handleResize)
    this.renderer.keyInput.off("keypress", this.handleKey)
    this.root.destroyRecursively()
  }

  private installMouseHandlers(): void {
    this.verticalSplitter.onMouseDown = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    this.verticalSplitter.onMouseDrag = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.geometry = resizeLeftPane(this.geometry, event.x)
      this.applyLayout()
    }
    this.horizontalSplitter.onMouseDown = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    this.horizontalSplitter.onMouseDrag = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.geometry = resizeCommandLog(this.geometry, event.y)
      this.applyLayout()
    }
    for (const pane of Object.values(this.panes)) {
      pane.box.onMouseDown = (event: MouseEvent) => {
        event.stopPropagation()
        this.focusManager.focus(pane.id)
      }
      pane.box.onMouseScroll = (event: MouseEvent) => {
        event.stopPropagation()
      }
    }
    this.panes.main.text.onMouseDown = (event: MouseEvent) => {
      event.stopPropagation()
      this.clearDiscardState()
    }
    this.commandLog.box.onMouseDown = (event: MouseEvent) => {
      event.stopPropagation()
      this.focusManager.focus("command-log")
    }
  }

  private applyFocus(active: FocusId): void {
    for (const pane of Object.values(this.panes)) pane.setFocused(pane.id === active)
    this.commandLog.setFocused(active === "command-log")
  }

  private applyLayout(): void {
    const geometry = this.geometry
    const main = geometry.windows.main
    const log = geometry.windows.log
    const legacy = {
      leftX: 0,
      leftWidth: geometry.sideWidth,
      leftHeight: geometry.terminalHeight,
      verticalSplitterX: geometry.sideWidth,
      verticalSplitterWidth: geometry.windows.vsplit === undefined ? 0 : 1,
      rightX: main?.x0 ?? 0,
      mainY: main?.y0 ?? 0,
      mainWidth: widthOf(main),
      mainHeight: heightOf(main),
      horizontalSplitterY: heightOf(main),
      horizontalSplitterHeight: geometry.windows.hsplit === undefined ? 0 : 1,
      logY: log?.y0 ?? 0,
      logHeight: geometry.logHeight,
      logVisible: geometry.logVisible,
      terminalHeight: geometry.terminalHeight,
      tooSmall: geometry.tooSmall,
    }
    const leftHeights = stackedHeights(legacy.terminalHeight, FOCUS_IDS.length - 1)
    let top = 0
    for (const id of FOCUS_IDS.slice(1)) {
      const pane = this.panes[id]
      const height = leftHeights[top === 0 ? 0 : FOCUS_IDS.indexOf(id) - 1] ?? 0
      pane.box.left = legacy.leftX
      pane.box.top = top
      pane.box.width = Math.max(1, legacy.leftWidth)
      pane.box.height = Math.max(1, height)
      pane.box.visible = legacy.leftWidth > 0 && height > 0
      top += height
    }

    const mainBox = this.panes.main.box
    mainBox.left = legacy.rightX
    mainBox.top = legacy.mainY
    mainBox.width = Math.max(1, legacy.mainWidth)
    mainBox.height = Math.max(1, legacy.mainHeight)
    mainBox.visible = legacy.mainWidth > 0 && legacy.mainHeight > 0
    this.verticalSplitter.left = legacy.verticalSplitterX
    this.verticalSplitter.top = 0
    this.verticalSplitter.width = Math.max(1, legacy.verticalSplitterWidth)
    this.verticalSplitter.height = Math.max(1, legacy.terminalHeight)
    this.verticalSplitter.visible = legacy.verticalSplitterWidth > 0
    this.horizontalSplitter.left = legacy.rightX
    this.horizontalSplitter.top = legacy.horizontalSplitterY
    this.horizontalSplitter.width = Math.max(1, legacy.mainWidth)
    this.horizontalSplitter.height = Math.max(1, legacy.horizontalSplitterHeight)
    this.horizontalSplitter.visible = legacy.logVisible && legacy.horizontalSplitterHeight > 0 && legacy.mainWidth > 0

    this.commandLog.box.left = legacy.rightX
    this.commandLog.box.top = legacy.logY
    this.commandLog.box.width = Math.max(1, legacy.mainWidth)
    this.commandLog.box.height = Math.max(1, legacy.logHeight)
    this.commandLog.box.visible = legacy.logVisible && legacy.logHeight > 0 && legacy.mainWidth > 0
    this.commandLog.resize(Math.max(1, legacy.mainWidth), Math.max(1, legacy.logHeight))
    this.commandLog.update(this.model.commandLog)
    updateMainPane(this.panes.main, this.model, legacy.tooSmall, this.activeMainOverride())
    this.root.requestRender()
  }
}

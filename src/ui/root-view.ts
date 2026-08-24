import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import type { AppModel } from "../app/model"
import {
  computeLayout,
  resizeCommandLog,
  resizeLeftPane,
  type LayoutGeometry,
} from "./layout"
import { FocusManager, FOCUS_IDS, type FocusId } from "./focus"
import { indexForStableId } from "../app/filter"
import { createBranchesPane, branchItemId, branchPaneItems, moveBranchesCursor, selectedBranchItem, updateBranchesPane } from "./panes/branches-pane"
import { createCommitsPane, getSelectedCommit, moveCommitsCursor, updateCommitsPane } from "./panes/commits-pane"
import { createCommandLogPane, type CommandLogPaneHandle } from "./panes/command-log-pane"
import { createFilesPane, filesPaneCommitAvailable, updateFilesPane } from "./panes/files-pane"
import { createMainPane, changeLineIndexes, getMainCursorTarget, getMainDocument, mainActionAvailability, mainPaneCommitAvailable, moveMainCursor, setMainCursorTarget, updateMainPane } from "./panes/main-pane"
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
import { CORE_KEYMAP, Keymap, normalizeKey } from "./keymap"
export type RootViewOptions = {
  readonly leftWidth?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly onStageFile?: (path: string) => Promise<void>
  readonly onUnstageFile?: (path: string) => Promise<void>
  readonly onDiscardFile?: (path: string, untracked: boolean) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onScopeChange?: (scope: "staged" | "unstaged") => Promise<void>
  readonly onModeChange?: (mode: "working-tree" | "branch") => Promise<void>
  readonly onChooseBase?: (baseRef: string) => Promise<void>
  readonly onCancelBase?: () => Promise<void>
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile?: (path: string) => void
  readonly onSelectCommit?: (oid: string) => Promise<void>
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

function stackedHeights(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

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
  private readonly onScopeChange: ((scope: "staged" | "unstaged") => Promise<void>) | undefined
  private readonly onModeChange: ((mode: "working-tree" | "branch") => Promise<void>) | undefined
  private readonly onChooseBase: ((baseRef: string) => Promise<void>) | undefined
  private readonly onCancelBase: (() => Promise<void>) | undefined
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private basePickerIndex = 0
  private readonly onSelectFile: ((path: string) => void) | undefined
  private readonly onSelectCommit: ((oid: string) => Promise<void>) | undefined
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
  private readonly keymap = new Keymap(CORE_KEYMAP)
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
          leftWidth: this.geometry.leftWidth,
          logHeight: this.geometry.logHeight,
          logVisible,
        },
      )
      this.applyLayout()
    }
    this.handleResize = () => {
      this.geometry = computeLayout(
        { width: renderer.terminalWidth, height: renderer.terminalHeight },
        {
          leftWidth: this.geometry.leftWidth,
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
      const modal = this.modalInputActive()
      const action = this.keymap.dispatch(routedKey, { context: this.focusManager.active, modal })
      if (action === "quit") {
        this.onQuit?.()
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (modal) {
        this.handleModalKey(routedKey)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (this.handleFilterKey(routedKey) || this.handleMutationKey(routedKey) || this.handleCopyKey(routedKey)) {
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (action?.startsWith("focus:")) {
        this.focusManager.handleKey(action.slice("focus:".length))
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (this.focusManager.handleKey(routedKey.name)) {
        key.preventDefault()
        key.stopPropagation()
      }
    }
    renderer.on("resize", this.handleResize)
    renderer.keyInput.on("keypress", this.handleKey)
    this.installMouseHandlers()
    this.applyFocus(this.focusManager.active)
    this.applyLayout()
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
    updateMainPane(this.panes.main, model, this.geometry.tooSmall)
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

  private handleModalKey(key: KeyEvent): void {
    if (this.branchFilterActive) {
      this.handleFilterKey(key)
      return
    }
    if (this.commitDialog !== undefined) {
      this.handleMutationKey(key)
      return
    }
    if (this.copyMenuOpen) {
      this.handleCopyKey(key)
      return
    }
    const navigation = key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down"
    const numeric = /^[0-9]$/.test(key.name)
    if (this.model.upstreamChoice !== undefined && (navigation || numeric || key.name === "enter" || key.name === "escape")) {
      this.handleMutationKey(key)
      return
    }
    if (this.model.basePicker !== undefined && (navigation || numeric || key.name === "enter" || key.name === "escape")) {
      this.handleMutationKey(key)
      return
    }
    if (key.name === "d" || key.name === "enter" || key.name === "escape") this.handleMutationKey(key)
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
  private handleCopyKey(key: KeyEvent): boolean {
    if (this.focusManager.active !== "main") return false
    if (this.copyMenuOpen) {
      if (key.name === "escape") {
        this.copyMenuOpen = false
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return true
      }
      const index = Number(key.name) - 1
      if (Number.isInteger(index) && index >= 0 && index < COPY_MENU_ITEMS.length) {
        this.copyMenuOpen = false
        this.copyMainMode(COPY_MENU_ITEMS[index]!.mode)
        return true
      }
      return true
    }
    if (key.ctrl && key.name === "o") {
      this.copyMainMode("text")
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "y") {
      this.copyMenuOpen = true
      this.panes.main.box.bottomTitle = `Copy: ${COPY_MENU_ITEMS.map((item, index) => `${index + 1} ${item.label}`).join(" | ")}`
      this.root.requestRender()
      return true
    }
    if (!key.ctrl && !key.meta && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
      this.moveMainCursor(key.name === "j" || key.name === "down" ? "next" : "previous")
      return true
    }
    return false
  }
  private handleMutationKey(key: KeyEvent): boolean {
    if (this.commitDialog !== undefined &&
      this.commitDialog.state.mode !== "stash" &&
      this.commitDialog.state.mode !== "branch-create" &&
      this.commitDialog.state.mode !== "branch-rename") {
      if (this.mutationInFlight) return true
      return this.handleCommitDialogKey(key)
    }
    if (this.commitDialog?.state.mode === "stash") {
      if (this.mutationInFlight) return true
      if (key.name === "u" && key.ctrl === true && !key.meta) {
        this.stashIncludeUntracked = !this.stashIncludeUntracked
        this.panes.main.box.bottomTitle = `${renderCommitDialog(this.commitDialog.state)}\nInclude untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`
        this.root.requestRender()
        return true
      }
      return this.handleStashDialogKey(key)
    }
    if (this.commitDialog?.state.mode === "branch-create" || this.commitDialog?.state.mode === "branch-rename") {
      if (this.mutationInFlight) return true
      return this.handleBranchDialogKey(key)
    }
    if (this.model.upstreamChoice !== undefined) {
      if (this.mutationInFlight) return true
      if (key.name === "escape") {
        if (this.onCancelUpstream !== undefined) this.runUiMutation(() => this.onCancelUpstream!())
        return true
      }
      if (this.onChooseUpstream === undefined) return true
      const count = this.model.upstreamChoice.candidates.length
      const numeric = Number(key.name) - 1
      if (Number.isInteger(numeric) && numeric >= 0 && numeric < count) {
        const choice = this.model.upstreamChoice.candidates[numeric]!
        this.runUiMutation(() => this.onChooseUpstream!(choice.remote, choice.branch))
        return true
      }
      if (count > 0 && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
        this.upstreamCursorIndex = Math.max(0, Math.min(count - 1, this.upstreamCursorIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        return true
      }
      if (count > 0 && key.name === "enter") {
        const choice = this.model.upstreamChoice.candidates[this.upstreamCursorIndex]!
        this.runUiMutation(() => this.onChooseUpstream!(choice.remote, choice.branch))
        return true
      }
      return true
    }
    const amendShortcut = key.name === "A" || (key.name === "a" && key.shift === true)
    if (!this.mutationInFlight && !key.ctrl && !key.meta && (key.name === "c" || amendShortcut)) {
      const commitAvailable = this.focusManager.active === "files"
        ? filesPaneCommitAvailable(this.model)
        : this.focusManager.active === "main" && mainPaneCommitAvailable(this.model)
      if (!commitAvailable) {
        this.panes.main.box.bottomTitle = "Commit is available in Files or Main staged scope"
        return true
      }
      if (key.name === "c" && this.onCommitMessage !== undefined) {
        this.openCommitDialog("commit", "")
        return true
      }
      if (amendShortcut && this.onAmendMessage !== undefined && this.onCurrentCommitMessage !== undefined) {
        this.openAmendDialog()
        return true
      }
    }
    if (!this.mutationInFlight && !key.ctrl && !key.meta && key.name === "s" && this.onCreateStash !== undefined &&
      !(this.focusManager.active === "branches" && this.branchFilterActive)) {
      this.stashIncludeUntracked = false
      this.openCommitDialog("stash", "")
      return true
    }
    if ((key.name === "R" || (key.name === "r" && key.shift)) && this.onRefresh !== undefined) {
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onRefresh!())
      return true
    }
    if (!this.mutationInFlight && !key.ctrl && !key.meta && key.name === "f" && this.focusManager.active !== "branches" && this.onFetch !== undefined) {
      this.runUiMutation(() => this.onFetch!())
      return true
    }
    if (!this.mutationInFlight && !key.ctrl && !key.meta && key.name === "p" &&
      !(this.focusManager.active === "branches" && this.branchFilterActive) && this.onPull !== undefined && key.shift !== true) {
      this.runUiMutation(() => this.onPull!())
      return true
    }
    if (!this.mutationInFlight && !key.ctrl && !key.meta && key.name === "p" && key.shift === true &&
      !(this.focusManager.active === "branches" && this.branchFilterActive) && this.onPush !== undefined) {
      this.runUiMutation(() => this.onPush!())
      return true
    }
    if (this.model.basePicker !== undefined) {
      if (this.mutationInFlight) return true
      if (key.name === "escape") {
        if (this.onCancelBase !== undefined) this.runUiMutation(() => this.onCancelBase!())
        return true
      }
      if (this.onChooseBase === undefined) return true
      const count = this.model.basePicker.candidates.length
      const numericIndex = Number(key.name) - 1
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < count) {
        this.runUiMutation(() => this.onChooseBase!(this.model.basePicker!.candidates[numericIndex]!))
        return true
      }
      if (count > 0 && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
        this.basePickerIndex = Math.max(0, Math.min(count - 1, this.basePickerIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        this.panes.status.box.bottomTitle = `${this.basePickerIndex + 1}/${count}: ${this.model.basePicker.candidates[this.basePickerIndex]} — Enter to choose`
        return true
      }
      if (count > 0 && key.name === "enter") {
        this.runUiMutation(() => this.onChooseBase!(this.model.basePicker!.candidates[this.basePickerIndex]!))
        return true
      }
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "b" && this.onModeChange !== undefined) {
      if (this.mutationInFlight) return true
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onModeChange!("branch"))
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "w" && this.onModeChange !== undefined) {
      if (this.mutationInFlight) return true
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.runUiMutation(() => this.onModeChange!("working-tree"))
      return true
    }
    if (this.focusManager.active === "stash") {
      const selected = selectedStashEntry(this.panes.stash, this.model)
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        this.pendingStashDrop = undefined
        this.panes.stash.box.bottomTitle = undefined
        moveStashCursor(this.panes.stash, this.model, key.name === "j" || key.name === "down" ? "next" : "previous")
        return true
      }
      if (selected !== undefined && (key.name === "space" || key.name === "g" || key.name === "enter") &&
        this.model.reviewTarget.kind === "working-tree" && !this.mutationInFlight) {
        const operation = key.name === "space" ? this.onApplyStash : key.name === "g" ? this.onPopStash : this.onInspectStash
        if (operation !== undefined) {
          this.runUiMutation(() => operation(selected.oid))
          return true
        }
      }
      if (selected !== undefined && key.name === "d" && this.onDropStash !== undefined && this.model.reviewTarget.kind === "working-tree" && !this.mutationInFlight) {
        if (this.pendingStashDrop?.oid === selected.oid) {
          this.pendingStashDrop = undefined
          this.panes.stash.box.bottomTitle = undefined
          this.runUiMutation(() => this.onDropStash!(selected.oid))
        } else {
          this.pendingStashDrop = selected
          this.panes.stash.box.bottomTitle = `Drop ${selected.ref}? Press d again to confirm or Escape to cancel.`
        }
        return true
      }
      if (key.name === "escape" && this.pendingStashDrop !== undefined) {
        this.pendingStashDrop = undefined
        this.panes.stash.box.bottomTitle = undefined
        return true
      }
      return false
    }
      if (this.mutationInFlight && ["space", "n", "r", "d", "f", "enter"].includes(key.name)) return true
    if (this.focusManager.active === "branches") {
      let selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
      if (this.branchFilterActive && key.name.length === 1 && !key.ctrl && !key.meta) {
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.branchFilter += key.name
        this.branchCursorIndex = 0
        selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
        updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
        return true
      }
      if (key.name === "backspace" && this.branchFilterActive) {
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.branchFilter = this.branchFilter.slice(0, -1)
        updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
        return true
      }
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.branchCursorIndex = moveBranchesCursor(this.model, this.branchCursorIndex, key.name === "j" || key.name === "down" ? "next" : "previous", this.branchFilter)
        updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
        return true
      }
      if (key.name === "space" && selected !== undefined) {
        if (selected.kind === "local" && this.onSwitchLocalBranch !== undefined) this.runUiMutation(() => this.onSwitchLocalBranch!(selected.name))
        if (selected.kind === "remote-branch" && this.onCheckoutRemoteTracking !== undefined) {
          this.runRemoteCheckout({ remote: selected.remote, branch: selected.name, ref: selected.ref }, false)
        }
        return true
      }
      if (key.name === "n" && this.onCreateBranch !== undefined) {
        this.branchDialogContext = { mode: "branch-create", ...(selected?.kind === "local" ? { startPoint: selected.name } : {}) }
        this.openBranchDialog("branch-create", "")
        return true
      }
      if (key.name === "d" && selected?.kind === "local" && this.onDeleteBranch !== undefined) {
        const force = key.shift === true
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
      if (key.name === "escape" && (this.pendingBranchDelete !== undefined || this.pendingRemoteMismatch !== undefined || this.branchFilterActive || this.remoteCheckoutInFlight)) {
        this.pendingBranchDelete = undefined
        this.invalidateRemoteCheckout()
        this.panes.branches.box.bottomTitle = undefined
        this.branchFilterActive = false
        this.filterInput.clear()
        this.filterInput.close()
        this.branchFilter = ""
        updateBranchesPane(this.panes.branches, this.model, this.branchCursorIndex, this.branchFilter)
        return true
      }
      if (key.name === "r" && selected?.kind === "local" && this.onRenameBranch !== undefined) {
        this.branchDialogContext = { mode: "branch-rename", branch: selected.name }
        this.openBranchDialog("branch-rename", "")
        return true
      }
      if (key.name === "f" && selected !== undefined) {
        if (selected.kind === "remote" && this.onFetchRemote !== undefined) this.runUiMutation(() => this.onFetchRemote!(selected.name))
        else this.panes.branches.box.bottomTitle = "Fetch is available for a selected remote"
        return true
      }
      if (key.name === "enter" && selected !== undefined) {
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
        return true
      }
      if (key.name === "/") {
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
        return true
      }
      return false
    }
    if (this.focusManager.active === "commits") {
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        moveCommitsCursor(this.panes.commits, this.model, key.name === "j" || key.name === "down" ? "next" : "previous")
        return true
      }
      if (key.name === "enter" && this.onSelectCommit !== undefined) {
        const selected = getSelectedCommit(this.panes.commits, this.model)
        if (selected !== undefined) {
          this.invalidateRemoteCheckout()
          this.runUiMutation(() => this.onSelectCommit!(selected.oid))
          this.focusManager.focus("files")
        }
        return true
      }
      if (key.name === "escape" && this.model.reviewTarget.kind === "commit" && this.onCommitBack !== undefined) {
        this.invalidateRemoteCheckout()
        this.runUiMutation(() => this.onCommitBack!())
      }
      return false
    }
    if (this.mutationInFlight && ["space", "d", "tab", "a"].includes(key.name)) {
      this.panes.main.box.bottomTitle = "Mutation in progress; wait for refresh"
      return true
    }
    if (this.model.reviewTarget.kind === "branch" && ["space", "d", "a"].includes(key.name)) {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return true
    }
    if (this.focusManager.active === "files") {
      if (key.name === "escape" && this.model.reviewTarget.kind === "commit" && this.onCommitBack !== undefined) {
        this.invalidateRemoteCheckout()
        this.runUiMutation(() => this.onCommitBack!())
        return true
      }
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        this.clearDiscardState()
        this.fileCursorIndex = Math.max(0, Math.min(this.model.files.length - 1, this.fileCursorIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        const selected = this.model.files[this.fileCursorIndex]
        this.panes.files.box.bottomTitle = selected?.path ?? "No files"
        if (selected !== undefined) this.onSelectFile?.(selected.path)
        return true
      }
      if (key.name === "enter") {
        const selected = this.model.files[this.fileCursorIndex]
        if (selected !== undefined) {
          if (this.model.reviewTarget.kind === "commit" && this.onSelectCommitFile !== undefined) {
            this.runUiMutation(() => this.onSelectCommitFile!(selected.path))
          } else {
            this.onSelectFile?.(selected.path)
          }
        }
        this.focusManager.focus("main")
        return true
      }
      const file = this.model.files[this.fileCursorIndex]
      if (key.name === "r" && this.onMarkFocusedFileReviewed !== undefined) {
        const focusedPath = this.model.focusId ?? this.model.selectionId
        const reviewPath = focusedPath !== undefined && this.model.files.some((candidate) => candidate.path === focusedPath)
          ? focusedPath
          : file?.path
        this.runUiMutation(() => this.onMarkFocusedFileReviewed!(reviewPath))
        return true
      }
      if (key.name === "a" && this.onToggleAllFiles !== undefined) {
        this.runUiMutation(() => this.onToggleAllFiles!())
        return true
      }
      if (file !== undefined && key.name === "space") {
        const staged = !file.untracked && file.worktreeStatus === "." && file.indexStatus !== "."
        const operation = staged ? this.onUnstageFile : this.onStageFile
        if (operation !== undefined) this.runUiMutation(() => operation(file.path))
        return operation !== undefined
      }
      if (file !== undefined && key.name === "d" && this.onDiscardFile !== undefined) {
        if (!file.untracked && file.worktreeStatus === "." && file.indexStatus !== ".") {
          this.panes.files.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
          return true
        }
        const pending = this.pendingFileDiscard
        if (pending?.path === file.path && pending.untracked === file.untracked) {
          this.pendingFileDiscard = undefined
          this.runUiMutation(() => this.onDiscardFile!(file.path, file.untracked))
        } else {
          this.pendingFileDiscard = { path: file.path, untracked: file.untracked }
          this.panes.files.box.bottomTitle = `${discardConfirmation(file.path, file.untracked).message} Press d again to confirm or Escape to cancel.`
        }
        return true
      }
      if (key.name === "escape" && this.pendingFileDiscard !== undefined) {
        this.clearDiscardState()
        this.panes.files.box.bottomTitle = undefined
        return true
      }
      return false
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all" && (key.name === "space" || key.name === "d")) {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press Tab to choose staged or unstaged"
      return true
    }
    if (this.focusManager.active !== "main") return false
    if (key.name === "escape" && this.model.reviewTarget.kind === "commit" && this.onCommitBack !== undefined) {
      this.runUiMutation(() => this.onCommitBack!())
      this.focusManager.focus("commits")
      return true
    }
    if (key.name === "tab" && this.onScopeChange !== undefined) {
      this.invalidateRemoteCheckout()
      const scope = this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged" ? "unstaged" : "staged"
      this.runUiMutation(() => this.onScopeChange!(scope))
      return true
    }
    if (key.name === "space" && this.onApplySelection !== undefined) {
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
      return true
    }
    if (key.name === "d" && this.onDiscardSelection !== undefined) {
      if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged") {
        this.panes.main.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
        return true
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
        return true
      }
      const availability = modelFile?.conflicted
        ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: conflicted file" }
        : modelFile !== undefined && !modelFile.untracked && modelFile.additions === 0 && modelFile.deletions === 0
          ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary file" }
          : mainActionAvailability(document, target)
      if (!availability.canDiscardLines) {
        this.panes.main.box.bottomTitle = availability.reason
        return true
      }
      if (selected === undefined || selected.indexes.length === 0) {
        this.panes.main.box.bottomTitle = "No changed lines selected"
      } else {
        const paths = this.selectionPaths(selected.document, selected.indexes)
        const label = paths.join(", ")
        if (!this.discardPending || this.pendingDiscardPaths.join("\u0000") !== paths.join("\u0000")) {
          this.discardPending = true
          this.pendingDiscardPaths = paths
          this.panes.main.box.bottomTitle = `${discardConfirmation(label || path).message} Press d again to confirm or Escape to cancel.`
        } else {
          this.clearDiscardState()
          this.runUiMutation(() => this.onDiscardSelection!(selected.document, selected.indexes))
        }
      }
      return true
    }
    if (key.name === "escape" && this.discardPending) {
      this.clearDiscardState()
      this.panes.main.box.bottomTitle = undefined
      return true
    }
    return false
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
    const leftHeights = stackedHeights(geometry.terminalHeight, FOCUS_IDS.length - 1)
    let top = 0
    for (const id of FOCUS_IDS.slice(1)) {
      const pane = this.panes[id]
      const height = leftHeights[top === 0 ? 0 : FOCUS_IDS.indexOf(id) - 1] ?? 0
      pane.box.left = geometry.leftX
      pane.box.top = top
      pane.box.width = Math.max(1, geometry.leftWidth)
      pane.box.height = Math.max(1, height)
      pane.box.visible = geometry.leftWidth > 0 && height > 0
      top += height
    }

    const main = this.panes.main.box
    main.left = geometry.rightX
    main.top = geometry.mainY
    main.width = Math.max(1, geometry.mainWidth)
    main.height = Math.max(1, geometry.mainHeight)
    main.visible = geometry.mainWidth > 0 && geometry.mainHeight > 0
    this.verticalSplitter.left = geometry.verticalSplitterX
    this.verticalSplitter.top = 0
    this.verticalSplitter.width = Math.max(1, geometry.verticalSplitterWidth)
    this.verticalSplitter.height = Math.max(1, geometry.terminalHeight)
    this.verticalSplitter.visible = geometry.verticalSplitterWidth > 0
    this.horizontalSplitter.left = geometry.rightX
    this.horizontalSplitter.top = geometry.horizontalSplitterY
    this.horizontalSplitter.width = Math.max(1, geometry.mainWidth)
    this.horizontalSplitter.height = Math.max(1, geometry.horizontalSplitterHeight)
    this.horizontalSplitter.visible = geometry.logVisible && geometry.horizontalSplitterHeight > 0 && geometry.mainWidth > 0

    this.commandLog.box.left = geometry.rightX
    this.commandLog.box.top = geometry.logY
    this.commandLog.box.width = Math.max(1, geometry.mainWidth)
    this.commandLog.box.height = Math.max(1, geometry.logHeight)
    this.commandLog.box.visible = geometry.logVisible && geometry.logHeight > 0 && geometry.mainWidth > 0
    this.commandLog.resize(Math.max(1, geometry.mainWidth), Math.max(1, geometry.logHeight))
    this.commandLog.update(this.model.commandLog)
    updateMainPane(this.panes.main, this.model, geometry.tooSmall)
    this.root.requestRender()
  }
}

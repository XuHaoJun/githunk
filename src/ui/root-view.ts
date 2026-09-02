import {
  BoxRenderable,
  StyledText,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import type { AppModel } from "../app/model"
import { sanitizeBranchName, type BranchDeleteRequest, type LocalBranch } from "../domain/branch"
import type { CommitDetails } from "../domain/commit"
import type { TagSummary, TagPreview } from "../domain/tag"
import type { Worktree } from "../domain/worktree"
import type { ReflogEntry } from "../domain/reflog"
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
import { createBranchesPane, BRANCHES_JUMP_KEY, BRANCHES_TABS, NO_BRANCHES_THIS_REPO, type BranchRowOptions } from "./panes/branches-pane"
import { localBranchRows } from "./panes/branches-pane"
import { buildPanePlainTitle, buildPaneTabsStrip, paneTabAtOffset } from "./pane-tabs"
import { remoteRows, remoteBranchRows } from "./panes/remotes-pane"
import { tagRows } from "./panes/tags-pane"
import { buildCommitRows, createCommitsPane } from "./panes/commits-pane"
import { COMMITS_JUMP_KEY, COMMITS_TABS, NO_REFLOG_HISTORY, reflogRows } from "./panes/reflog-pane"
import type { RefLogTarget } from "../git/ref-log"
import type { ItemOperation } from "../domain/item-operation"
import { SPINNER_RATE_MS } from "./loader"
import { parseAnsi } from "./ansi"
import { NO_BRANCHES_FOR_REMOTE, NO_REMOTES, remotePreviewText } from "./panes/remotes-pane"
import { NO_TAGS, tagPreamble } from "./panes/tags-pane"
import { createCommandLogPane, type CommandLogPaneHandle } from "./panes/command-log-pane"
import { FILES_JUMP_KEY, FILES_TABS, NO_CHANGED_FILES, anyStagedChanges, createFilesPane, createFilesTreeState, fileHasStagedChanges, fileHasUnstagedChanges, filesTreeRows } from "./panes/files-pane"
import { NO_WORKTREES_THIS_REPO, selectedWorktreeFrom, worktreePreviewText, worktreeRows } from "./panes/worktrees-pane"
import { NO_SUBMODULES, selectedSubmoduleFrom, submodulePreviewText, submoduleRows } from "./panes/submodules-pane"
import {
  collapseAllFileTree,
  expandAllFileTree,
  fileTreeRows,
  setFileTreeItems,
  someFileInNode,
  toggleFileTreeCollapsedPath,
  toggleFileTreeMode,
  type FileTreeRow,
  type FileTreeState,
} from "./file-tree"
import { submoduleFullName } from "../domain/submodule"
import { createMainPane, changeLineIndexes, clampMainScroll, getMainCursorTarget, getMainDiffLineRangeState, getMainDiffLineSelection, getMainDocument, getMainRenderedText, installMainContent as installMainPaneContent, mainActionAvailability, mainCursorTargetLine, mainDiffVisualRowRange, moveMainCursor, scrollMainPane, setMainCursorTarget, setMainDiffLineRangeState, setMainLoading, MAIN_TITLE_LOG, MAIN_TITLE_REMOTE, MAIN_TITLE_REMOTE_BRANCH, MAIN_TITLE_TAG, type MainCursorTarget, type MainPaneContent } from "./panes/main-pane"
import { createStashPane, selectedStashEntryFromState, stashRows } from "./panes/stash-pane"
import { createStatusPane, updateStatusPane } from "./panes/status-pane"
import { PANE_SCROLLBAR_GUTTER, paneScrollbar, scrollYToReveal, syncVerticalScrollbar, type PaneHandle } from "./panes/common"
import { copySelection, selectionFromRenderable } from "../domain/diff/selection"
import { clearDiffLineRange, diffLineSelectionRange, expandDiffLineRange, moveDiffLineSelection, toggleDiffLineRange } from "../domain/diff/line-selection"
import type { CopyMode, DiffDocument } from "../domain/diff/document"
import { parseDiff } from "../domain/diff/parse"
import { ClipboardService, formatCopyResult, type ClipboardPort } from "./clipboard"
import { discardConfirmation, stashApplyConfirmation, stashDropConfirmation, stashPopConfirmation, type ConfirmationRequest } from "./confirm-dialog"
import { branchAutostashConfirmation, branchForceDeleteConfirmation, branchLocalAndRemoteDeleteConfirmation, branchRemoteDeleteConfirmation, branchRenameConfirmation, remoteTrackingMismatchConfirmation, worktreeForceRemoveConfirmation } from "./branch-dialogs"
import { COPY_MENU_ITEMS } from "./copy-menu"
import { branchCheckoutRequiresStash, type CheckoutRemoteTrackingResult, type CreateBranchOptions, type RemoteBranchSelection } from "../git/branches"
import { worktreeRemovalRequiresForce } from "../git/worktrees"
import { CommitDialog, commitDialogKey, renderCommitDialog } from "./commit-dialog"
import { createCommitMessagePanel, type CommitMessagePanelHandle } from "./commit-message-panel"
import { createPromptPopup, type PromptPopupHandle } from "./prompt-popup"
import { FilterInput } from "./filter-input"
import { filterItems } from "../app/filter"
import { normalizeKey } from "./keymap"
import { createHintsBar, reviewStatusText, type HintsBarHandle } from "./hints-bar"
import { createKeybindingMenu, type KeybindingMenuHandle } from "./keybinding-menu"
import { createActionMenu, type ActionMenuHandle } from "./action-menu"
import { createSplitter, type SplitterAxis, type SplitterHandle } from "./splitter"
import { type UiState as PersistedUiState } from "./ui-state-store"
import { createRegistry, type Action, type MenuEntry, type UiState } from "./bindings"
import { createPanelState, cyclePanelTab, enterPanelChild, leavePanelChild, updatePanelView, type PanelState } from "./panel-state"
import { ANSI_CYAN, ANSI_GREEN, DEFAULT_FOREGROUND, TITLE_PREFIX_FRAME_RUNE } from "./theme"
import {
  createListState,
  expandListRangeSelection,
  listRowAtPoint,
  moveListSelection,
  renderListRows,
  selectListRow,
  setListRangeSelection,
  setListRows,
  toggleListRangeSelection,
  type ListState,
  type ListRow,
} from "./list-view"
import { MainPreviewGate } from "./main-preview"
import type { CommitSummary } from "../domain/commit"
// Review workspace screen ownership is managed by AppScreenController (src/app/screen-controller.ts).
// This view remains the repository workspace; it is hidden (not destroyed) when the review screen is active,
// and its focus/selection is remembered for restoration on Escape.
const PANE_TITLES: Readonly<Record<FocusId, string>> = {
  main: "Main", status: "Review", files: "Files",
  branches: "Branches", commits: "Commits", stash: "Stash",
  // `Tr.CommandLog` (pkg/i18n/english.go:1928) — lowercase "log", as the pane's own title reads.
  "command-log": "Command log",
}

function paneTitleFor(focus: FocusId): string {
  return PANE_TITLES[focus]
}
/** Panel 2's tab keys, in the same order as `FILES_TABS`' labels. */
const FILES_TAB_ORDER = ["files", "worktrees", "submodules"] as const
/** Panel 3's tab keys, in the same order as `BRANCHES_TABS`' labels. */
const BRANCHES_TAB_ORDER = ["branches", "remotes", "tags"] as const
/** Panel 4's tab keys, in the same order as `COMMITS_TABS`' labels. */
const COMMITS_TAB_ORDER = ["commits", "reflog"] as const

type PaneWindowDimensions = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
type ListPaneId = "files" | "branches" | "commits" | "stash"

type ActiveListView = {
  readonly paneId: ListPaneId
  readonly viewId: string
  readonly state: ListState
}

type HoveredListRow = {
  readonly paneId: ListPaneId
  readonly viewId: string
  readonly rowId: string
}


/**
 * The scrollbar is painted above the list's rightmost text cell. Reserve that cell only when
 * this list has more rows than its bordered pane can display; ScrollBarRenderable auto-hides when
 * the content fits, so short lists keep their full width.
 */
function sidePaneListWidth(win: PaneWindowDimensions | undefined, state: ListState): number {
  if (win === undefined) return 80
  const contentWidth = Math.max(0, widthOf(win) - 2)
  const viewportHeight = sidePaneViewportHeight(win) ?? 1
  const scrollbarGutter = state.displayRows.length > viewportHeight ? PANE_SCROLLBAR_GUTTER : 0
  return Math.max(0, contentWidth - scrollbarGutter)
}
function sidePaneViewportHeight(win: PaneWindowDimensions | undefined): number | undefined {
  return win === undefined ? undefined : Math.max(1, heightOf(win) - 2)
}

type BranchesPanelChild =
  | { readonly kind: "remote-branches"; readonly remote: string }
  | { readonly kind: "local-commits"; readonly branch: string }

/** Ring order for the `[` / `]` scope-cycle keys in the main pane (PRD §8.1 review targets). */
const SCOPE_ORDER: readonly WorkingTreeScope[] = ["all", "staged", "unstaged"]

function liveBranchUpstream(branch: LocalBranch): { readonly remote: string; readonly branch: string } | undefined {
  if (branch.upstreamGone === true) return undefined
  if (branch.upstreamRemote !== undefined && branch.upstreamRemote.length > 0 &&
    branch.upstreamBranch !== undefined && branch.upstreamBranch.length > 0) {
    return { remote: branch.upstreamRemote, branch: branch.upstreamBranch }
  }
  const upstream = branch.upstream
  if (upstream === undefined) return undefined
  const separator = upstream.indexOf("/")
  if (separator <= 0 || separator === upstream.length - 1) return undefined
  return { remote: upstream.slice(0, separator), branch: upstream.slice(separator + 1) }
}

export type RootViewOptions = {
  readonly sidePanelRatio?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly onGeometryChange?: (state: PersistedUiState) => void
  /**
   * Fired whenever a git operation this view started has settled, however it settled. The single
   * choke point for "githunk just touched the repository": the refs watcher re-seeds its baseline
   * here, so githunk's own commits and checkouts are never mistaken for external ones.
   */
  readonly onMutationSettled?: () => void
  readonly onStageFile?: (path: string) => Promise<void>
  readonly onUnstageFile?: (path: string) => Promise<void>
  readonly onDiscardFile?: (path: string, mode: DiscardFileMode) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onScopeChange?: (scope: WorkingTreeScope) => Promise<void>
  readonly onOpenBranchReview?: () => Promise<void>
  readonly isBranchReviewActive?: () => boolean
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile?: (path: string) => void
  readonly loadCommitInspection?: (oid: string) => Promise<CommitDetails>
  readonly loadBranchCommits?: (branch: string) => Promise<readonly CommitSummary[]>
  readonly loadCommitFileInspection?: (oid: string, path: string) => Promise<DiffDocument>
  readonly loadTagInspection?: (tag: TagSummary) => Promise<TagPreview>
  readonly loadRefLogInspection?: (target: RefLogTarget) => Promise<string>
  readonly onPreviewError?: (error: unknown) => void
  readonly onMarkFocusedFileReviewed?: (path?: string) => Promise<void>
  readonly onCommitMessage?: (message: string) => Promise<void>
  readonly onAmendMessage?: (message: string) => Promise<void>
  readonly onCurrentCommitMessage?: () => Promise<string>
  readonly onRefresh?: () => Promise<void>
  readonly onSwitchLocalBranch?: (branch: string) => Promise<void>
  readonly onCreateBranch?: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onCreateBranchWithAutostash?: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onDeleteBranch?: (request: BranchDeleteRequest) => Promise<void>
  readonly onCheckBranchMerged?: (branch: string, upstream?: string) => Promise<boolean>
  readonly onDeleteBranchFromWorktree?: (path: string, action: "remove" | "detach", request: BranchDeleteRequest, forceWorktree?: boolean) => Promise<void>
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
  readonly onEditFile?: (path: string, line?: number) => Promise<void>
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
  | { readonly kind: "list-range"; readonly paneId: ListPaneId; readonly viewId: string; readonly anchorId: string }


/**
 * Lines the main view scrolls per press of the *global* scroll keys — lazygit's
 * `gui.scrollHeight`, default 2 (pkg/config/user_config.go:857). `<pgup>`/`<pgdown>`, `K`/`J` and
 * `<ctrl+u>`/`<ctrl+d>` are all aliases of the one handler (`scrollUpMain`/`scrollDownMain`,
 * pkg/gui/global_handlers.go:15-22), as is the mouse wheel over the main view
 * (keybindings.go:177-189), so they all move by this.
 */
export const MAIN_SCROLL_HEIGHT = 2

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
  private pendingClick: { readonly viewId: string; readonly stableId: string; readonly x: number; readonly y: number; readonly at: number; readonly arrowToggled?: boolean } | undefined
  private hoveredListRow: HoveredListRow | undefined

  private model: AppModel
  private readonly panes: Record<Exclude<FocusId, "command-log">, PaneHandle>
  private readonly commandLog: CommandLogPaneHandle
  private renderedCommandLogArms = 0
  private commandLogFocused = false
  private readonly clipboard: ClipboardService
  private readonly verticalSplitter: SplitterHandle
  private readonly horizontalSplitter: SplitterHandle
  private readonly hintsBar: HintsBarHandle
  private readonly keybindingMenu: KeybindingMenuHandle
  private readonly actionMenu: ActionMenuHandle
  private readonly onStageFile: ((path: string) => Promise<void>) | undefined
  private readonly onUnstageFile: ((path: string) => Promise<void>) | undefined
  private readonly onDiscardFile: ((path: string, mode: DiscardFileMode) => Promise<void>) | undefined
  private readonly onToggleAllFiles: (() => Promise<void>) | undefined
  private readonly onScopeChange: ((scope: WorkingTreeScope) => Promise<void>) | undefined
  private readonly onOpenBranchReview: (() => Promise<void>) | undefined
  private readonly isBranchReviewActive: (() => boolean) | undefined
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private readonly onSelectFile: ((path: string) => void) | undefined
  private readonly loadCommitInspection: ((oid: string) => Promise<CommitDetails>) | undefined
  private readonly loadCommitFileInspection: ((oid: string, path: string) => Promise<DiffDocument>) | undefined
  private readonly loadTagInspection: ((tag: TagSummary) => Promise<TagPreview>) | undefined
  private readonly loadRefLogInspection: ((target: RefLogTarget) => Promise<string>) | undefined
  /**
   * List row id → the operation currently running against it, lazygit's
   * `State().SetItemOperation` / `ClearItemOperation` (pkg/gui/controllers/helpers/
   * inline_status_helper.go:99-138). Held by the view, not the model: it describes what the UI is
   * doing, and it must survive the model replacement a mid-operation refresh performs.
   */
  private readonly itemOperations = new Map<string, ItemOperation>()
  /**
   * Repaints the panels carrying an inline status, at the spinner's own rate. lazygit runs exactly
   * this ticker for the duration of an operation (inline_status_helper.go:109-121), and stops it
   * when the last one finishes so an idle app draws nothing.
   */
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  private readonly onPreviewError: ((error: unknown) => void) | undefined
  private readonly onCommitMessage: ((message: string) => Promise<void>) | undefined
  private readonly onAmendMessage: ((message: string) => Promise<void>) | undefined
  private readonly onCurrentCommitMessage: (() => Promise<string>) | undefined
  private readonly commitMessagePanel: CommitMessagePanelHandle
  private readonly promptPopup: PromptPopupHandle
  private commitDialog: CommitDialog | undefined
  /** Arms the second-press stage-everything confirmation of withEnsureCommittableFiles. */
  private pendingStageAllCommit: boolean = false
  private readonly onMarkFocusedFileReviewed: ((path?: string) => Promise<void>) | undefined
  private readonly onRefresh: (() => Promise<void>) | undefined
  private readonly onSwitchLocalBranch: ((branch: string) => Promise<void>) | undefined
  private readonly onCreateBranch: ((startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>) | undefined
  private readonly onCreateBranchWithAutostash: ((startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>) | undefined
  private readonly onDeleteBranch: ((request: BranchDeleteRequest) => Promise<void>) | undefined
  private readonly onCheckBranchMerged: ((branch: string, upstream?: string) => Promise<boolean>) | undefined
  private readonly onDeleteBranchFromWorktree: ((path: string, action: "remove" | "detach", request: BranchDeleteRequest, forceWorktree?: boolean) => Promise<void>) | undefined
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
  private readonly loadBranchCommits: ((branch: string) => Promise<readonly CommitSummary[]>) | undefined
  private readonly onInspectBranch: ((branch: string) => Promise<void>) | undefined
  private readonly onCheckoutRemoteTracking: ((selection: RemoteBranchSelection, confirmedMismatch?: boolean) => Promise<CheckoutRemoteTrackingResult | undefined>) | undefined
  private readonly onFilterBranches: (() => Promise<void>) | undefined
  private readonly onEditFile: ((path: string, line?: number) => Promise<void>) | undefined
  private copyMenuOpen = false
  private menuOpen = false
  private upstreamCursorIndex = 0
  private stashIncludeUntracked = false
  private branchDialogContext:
    | { readonly mode: "branch-create"; readonly startPoint?: string; readonly suggestedBranchName: string; readonly branchBase: string }
    | { readonly mode: "branch-rename"; readonly branch: string }
    | undefined
  private mutationInFlight = false
  private pendingRemoteMismatch: { readonly selection: RemoteBranchSelection; readonly message: string } | undefined
  private remoteCheckoutGeneration = 0
  private remoteCheckoutInFlight = false
  private branchFilter = ""
  private branchFilterActive = false
  private branchCommitsRequest = 0
  private branchActionGeneration = 0
  // Generic "/" filter/search state for every other panel (lazygit's per-context filter).
  // Branches keep their own `branchFilter`/`branchFilterActive` for minimal churn; all other
  // contexts share `filters` keyed by `pane:tab` or `pane:tab:child`.
  private filters = new Map<string, string>()
  private activeFilterKey: string | undefined
  branchesPanel: PanelState<"branches" | "remotes" | "tags", BranchesPanelChild>
  commitsPanel: PanelState<"commits" | "reflog", { kind: "commit-files"; oid: string; details: CommitDetails }>
  filesPanel: PanelState<"files" | "worktrees" | "submodules", never>
  /**
   * The Files tab's tree, kept next to the panel rather than inside it: `PanelState` stores one
   * `ListState` per tab, and the tree is the *source* those rows are rendered from — collapse,
   * flat/tree mode and the collapsed-path set all outlive any single row list.
   */
  filesTree: FileTreeState<ChangedFile>
  stashState: ListState
  private mainGate!: MainPreviewGate
  private installedMainContent: MainPaneContent | undefined
  private filesDocumentCache: { readonly text: string; readonly document: DiffDocument } | undefined
  private filesSelectionCache: { readonly text: string; readonly rowId: string; readonly document: DiffDocument } | undefined
  /** `tooSmall` as of the last main-pane install, so a layout pass can tell whether it changed. */
  private installedMainTooSmall = false
  private mainLoading = false
  private previewInflight: Promise<void> = Promise.resolve()
  private branchCommitsInflight: Promise<void> = Promise.resolve()
  private readonly registry = createRegistry()
  private readonly onQuit: (() => void) | undefined
  private readonly onGeometryChange: ((state: PersistedUiState) => void) | undefined
  private readonly onMutationSettled: (() => void) | undefined
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
    this.onScopeChange = options.onScopeChange
    this.onOpenBranchReview = options.onOpenBranchReview
    this.isBranchReviewActive = options.isBranchReviewActive
    this.onQuit = options.onQuit
    this.onGeometryChange = options.onGeometryChange
    this.onMutationSettled = options.onMutationSettled
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
    this.onCreateBranchWithAutostash = options.onCreateBranchWithAutostash
    this.onDeleteBranch = options.onDeleteBranch
    this.onCheckBranchMerged = options.onCheckBranchMerged
    this.onDeleteBranchFromWorktree = options.onDeleteBranchFromWorktree
    this.onRenameBranch = options.onRenameBranch
    this.onBrowseRemote = options.onBrowseRemote
    this.onInspectBranch = options.onInspectBranch
    this.onCheckoutRemoteTracking = options.onCheckoutRemoteTracking
    this.onFilterBranches = options.onFilterBranches
    this.onEditFile = options.onEditFile
    this.loadCommitInspection = options.loadCommitInspection
    this.loadCommitFileInspection = options.loadCommitFileInspection
    this.loadTagInspection = options.loadTagInspection
    this.loadRefLogInspection = options.loadRefLogInspection
    this.loadBranchCommits = options.loadBranchCommits
    this.onPreviewError = options.onPreviewError
    this.onCommitMessage = options.onCommitMessage
    this.onAmendMessage = options.onAmendMessage
    this.onCurrentCommitMessage = options.onCurrentCommitMessage
    this.onMarkFocusedFileReviewed = options.onMarkFocusedFileReviewed
    this.renderer = renderer
    this.model = model
    // Shown unless the caller says otherwise, matching `Gui.ShowCommandLog: true`
    // (pkg/config/user_config.go:901).
    this.focusManager.logVisible = options.logVisible ?? true
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
      const branchesRows = localBranchRows(model, this.branchFilter, this.branchRowOptions())
      const remotesRowsData = remoteRows(model, this.branchFilter)
      const tagsRowsData = tagRows(model, this.branchFilter)
      this.branchesPanel = createPanelState(
        ["branches", "remotes", "tags"] as const,
        "branches",
        {
          branches: createListState(branchesRows, branchesRows.length === 0 ? [{ kind: "message", text: "No branches" }] : undefined),
          remotes: createListState(remotesRowsData, remotesRowsData.length === 0 ? [{ kind: "message", text: "No remotes" }] : undefined),
          tags: createListState(tagsRowsData, tagsRowsData.length === 0 ? [{ kind: "message", text: "No tags" }] : undefined),
        },
      )
      this.renderBranchesPane()
    }
    // Initialize PanelState for window 4 (commits + transient commit-files)
    {
      const commits = model.commits ?? []
      const rows = buildCommitRows(commits, new Date())
      const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: model.loading ? "Loading…" : "No commits" }] : undefined
      const reflog = reflogRows(model)
      const reflogDisplayRows = reflog.length === 0 ? [{ kind: "message" as const, text: NO_REFLOG_HISTORY }] : undefined
      this.commitsPanel = createPanelState(
        ["commits", "reflog"] as const,
        "commits",
        {
          commits: createListState(rows, displayRows),
          reflog: createListState(reflog, reflogDisplayRows),
        },
      )
      this.renderCommitsPane()
    }
    // Panel 2's tabs are lazygit's `{"files", "worktrees", "submodules"}` group
    // (pkg/config/user_config.go:872). Worktrees and Submodules are navigation-only here.
    {
      this.filesTree = createFilesTreeState(model)
      const rows = filesTreeRows(this.filesTree, model)
      const worktrees = worktreeRows(model)
      const submodules = submoduleRows(model)
      this.filesPanel = createPanelState(
        ["files", "worktrees", "submodules"] as const,
        "files",
        {
          files: createListState(rows, rows.length === 0 ? [{ kind: "message", text: NO_CHANGED_FILES }] : undefined),
          worktrees: createListState(worktrees, worktrees.length === 0 ? [{ kind: "message", text: NO_WORKTREES_THIS_REPO }] : undefined),
          submodules: createListState(submodules, submodules.length === 0 ? [{ kind: "message", text: NO_SUBMODULES }] : undefined),
        },
      )
      this.renderFilesPane()
    }
    {
      const rows = stashRows(model)
      const text = model.reviewTarget.kind === "stash" ? `* ${model.reviewTarget.ref}` : "No stashes"
      const displayRows = rows.length === 0 ? [{ kind: "message" as const, text }] : undefined
      this.stashState = createListState(rows, displayRows)
      this.renderStashPane()
    }
    this.mainGate = new MainPreviewGate({
      install: (content) => {
        this.installedMainContent = content
        this.installedMainTooSmall = this.geometry.tooSmall
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
    this.actionMenu = createActionMenu(renderer)
    this.commitMessagePanel = createCommitMessagePanel(renderer)
    this.promptPopup = createPromptPopup(renderer)
    this.root.add(this.hintsBar.hints)
    this.root.add(this.hintsBar.status)
    this.root.add(this.keybindingMenu.box)
    this.root.add(this.actionMenu.box)
    this.root.add(this.commitMessagePanel.box)
    this.root.add(this.promptPopup.box)
    renderer.root.add(this.root)

    this.focusManager.onChange = (focus, logVisible) => {
      this.branchActionGeneration += 1
      // Route through the same arm comparison `update(model)` uses (see the comment there), not a
      // bare `commandLog.update`: a wheel scroll does not require focus (task 5), so the
      // focus-lost re-arm never fires for a log that was scrolled and then hidden. Skipping the
      // comparison on reopen left it wherever that scroll ended, instead of re-pinning to the
      // bottom for any mutation that logged output while it was hidden.
      if (logVisible) this.refreshCommandLog(this.model)
      this.pendingClick = undefined
      this.cancelGesture()
      this.clearTransientMenus()
      this.invalidateRemoteCheckout()
      this.invalidateBranchCommitsRequest()
      this.panes.stash.box.bottomTitle = undefined
      this.panes.branches.box.bottomTitle = undefined
      this.branchFilterActive = false
      this.activeFilterKey = undefined
      this.filterInput.close()
      this.applyFocus(focus)
      this.renderBranchesPane()
      this.renderCommitsPane()
      this.renderFilesPane()
      this.renderStashPane()
      this.recomputeLayout()
      this.syncPreviewForFocus(focus)
    }
    this.handleResize = () => {
      this.recomputeLayout()
    }
    this.handleKey = (key: KeyEvent) => {
      if (this.isBranchReviewActive?.()) return
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
      // Dialogs and action menus consume input before the focused-main Escape shortcut. Otherwise a
      // menu opened while CommitFiles is active would pop the commit child and leave the menu up.
      if (this.modalInputActive()) {
        this.handleModalKey(routedKey)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (routedKey.name === "escape" && this.commitsPanel.child !== undefined) {
        this.actionBack()
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
    this.branchActionGeneration += 1
    this.invalidateBranchCommitsRequest()
    if (!options.preserveRemoteCheckout) {
      this.branchFilterActive = false
      this.branchFilter = ""
      this.filterInput.clear()
      this.filterInput.close()
    }
    this.model = model
    if (model.upstreamChoice !== undefined) {
      this.upstreamCursorIndex = Math.min(this.upstreamCursorIndex, Math.max(0, model.upstreamChoice.candidates.length - 1))
      const items = model.upstreamChoice.candidates.map((candidate, index) => ({
        key: String(index + 1),
        label: `${candidate.remote}/${candidate.branch}`,
        onPress: () => {
          if (this.onChooseUpstream !== undefined) this.runUiMutation(() => this.onChooseUpstream!(candidate.remote, candidate.branch))
        },
      }))
      this.actionMenu.openMenu(
        `Upstream required for ${model.upstreamChoice.branch}`,
        items,
        model.upstreamChoice.candidates.length === 0 ? "No candidates — Esc to cancel" : "Choose an upstream (j/k, 1-9, Enter) — Esc to cancel",
      )
    } else if (this.actionMenu.isOpen() && (this.actionMenu.box.title ?? "").startsWith("Upstream")) {
      this.actionMenu.close()
    }
    updateStatusPane(this.panes.status, model)
    this.refreshFilesPanel(model)
    this.renderFilesPane()
    this.refreshBranchesPanel(model)
    this.renderBranchesPane()
    const localChild = this.branchesPanel.child
    if (localChild?.value.kind === "local-commits") this.requestLocalBranchCommits(localChild.value.branch, false)
    this.refreshCommitsPanel(model)
    this.renderCommitsPane()
    this.refreshStashState(model)
    this.renderStashPane()
    // lazygit's `postRefreshUpdate` (pkg/gui/view_helpers.go:135): while the focused context is
    // the main view, the *side* context underneath it in the stack is the one asked to
    // re-render main — the main context itself has nothing to render.
    this.syncPreviewForFocus(this.focusManager.active === "main" ? this.focusManager.lastSide : this.focusManager.active)
    // A hidden log is not worth rendering: nothing on screen needs the paint. The arm count
    // `refreshCommandLog` compares against is deliberately not consumed while hidden (see its own
    // comment), so a whole hidden burst still arms exactly once, on the next call after it
    // reopens. `applyFocus` renders it when it opens.
    if (this.focusManager.logVisible) this.refreshCommandLog(model)
    this.recomputeLayout()
  }

  /**
   * Applies the arm comparison and hands the log its current lines. lazygit arms autoscroll
   * inside `LogAction`/`LogCommand` (pkg/gui/command_log_panel.go:38,62) — at write time.
   * RootView only ever sees the last snapshot of a controller action (`view.update` fires once
   * per controller call, src/app/create-app.ts:246), and a mutation logs its output *after* its
   * command line, so arming on the newest write's kind would drop the arm for every batch that
   * ends in output. Arm on the count of arming writes having grown instead: idempotent and
   * independent of how many snapshots the batch took. Callers gate this on log visibility: while
   * the log is hidden the count is not consumed, so a whole hidden burst arms exactly once on the
   * next call, whether that is the next `update(model)` or the log's own reopening.
   */
  private refreshCommandLog(model: AppModel): void {
    const arms = model.commandLogAutoscrollArms ?? 0
    if (arms > this.renderedCommandLogArms) this.commandLog.applyScrollInput("append-entry")
    this.renderedCommandLogArms = arms
    this.commandLog.update(model.commandLog)
  }
  private clearTransientMenus(): void {
    this.actionMenu.close()
  }
  private modalInputActive(): boolean {
    return this.branchFilterActive || this.filterInput.state.active || this.promptPopup.visible || this.commitMessagePanel.visible || this.copyMenuOpen ||
      this.actionMenu.isOpen() ||
      this.menuOpen ||
      this.model.upstreamChoice !== undefined ||
      this.pendingRemoteMismatch !== undefined
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
    return this.commitsView()?.selectedIndex ?? 0
  }
  get mainPane(): PaneHandle { return this.panes.main }
  /** The main pane's hunk cursor — what `h`/`l` move and line staging acts on. Test accessor. */
  get mainCursorTarget(): MainCursorTarget | undefined { return getMainCursorTarget(this.panes.main) }
  get commitsPane(): PaneHandle { return this.panes.commits }
  get filesPane(): PaneHandle { return this.panes.files }
  get branchesPane(): PaneHandle { return this.panes.branches }
  get stashPane(): PaneHandle { return this.panes.stash }
  /** Whether the shared transient action menu is open; test and embedding seam. */
  get actionMenuOpen(): boolean { return this.actionMenu.isOpen() }
  get statusPane(): PaneHandle { return this.panes.status }
  paneFor(id: (typeof FOCUS_IDS)[number]): PaneHandle {
    return this.panes[id]
  }
  get commitsSelectedOid(): string | undefined {
    const panel = this.commitsPanel
    if (panel.child !== undefined) return panel.child.view.selectedId?.split("\u0000")[0] ?? panel.child.value.oid
    if (panel.activeTab === "reflog") return this.selectedReflogEntry()?.oid
    return panel.views.commits?.selectedId
  }

  get activeCommitsTab(): "commits" | "reflog" {
    return this.commitsPanel.activeTab
  }

  /** The list panel 4 is showing: the drill-down child if any, else the active tab's view. */
  private commitsView(): ListState | undefined {
    const panel = this.commitsPanel
    return panel.child?.view ?? panel.views[panel.activeTab]
  }

  get activeFilesTab(): "files" | "worktrees" | "submodules" {
    return this.filesPanel.activeTab
  }

  /** The list panel 2 is showing: the active tab's view. */
  private filesView(): ListState | undefined {
    return this.filesPanel.views[this.filesPanel.activeTab]
  }

  /** The tree row the Files tab has selected — a file row or a directory row. */
  private selectedFileRow(): FileTreeRow<ChangedFile> | undefined {
    const id = this.filesPanel.views.files?.selectedId
    if (id === undefined) return undefined
    return fileTreeRows(this.filesTree).find((row) => row.id === id)
  }

  /** The lazygit Files arrow hit area, including the review marker and separator columns. */
  private filesTreeArrowRowAt(stableId: string, eventX: number, screenX: number): FileTreeRow<ChangedFile> | undefined {
    if (this.filesPanel.activeTab !== "files") return undefined
    const row = fileTreeRows(this.filesTree).find((candidate) => candidate.id === stableId)
    if (row?.kind !== "directory") return undefined
    const arrowStartX = screenX + 2 + row.visualDepth * 2
    return eventX >= arrowStartX && eventX <= arrowStartX + 1 ? row : undefined
  }

  /** The reflog entry the Reflog tab has selected, resolved through the model by row id. */
  private selectedReflogEntry(): ReflogEntry | undefined {
    const id = this.commitsPanel.views.reflog?.selectedId
    if (id === undefined) return undefined
    return (this.model.reflog ?? []).find((entry) => entry.id === id)
  }
  /** The command log pane's `view.Autoscroll` (pkg/gui/extras_panel.go:48-94), for tests. */
  get commandLogAutoscroll(): boolean {
    return this.commandLog.autoscroll
  }
  /** The command log's scroll extent, for tests asserting an armed viewport is pinned. */
  commandLogMaxScrollY(): number {
    return this.commandLog.maxScrollY()
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

  selectedListId(pane: "files" | "branches" | "commits" | "stash" | string): string | undefined {
    // The Files tab's rows are identified by `file:`/`dir:` prefixed tree paths internally; the
    // path is what callers mean by "the selection", so that is what is reported here. The two
    // read-only tabs have no such split and report their row ids unchanged.
    if (pane === "files") {
      if (this.filesPanel.activeTab !== "files") return this.filesView()?.selectedId

      return this.selectedFileRow()?.path
    }
    if (pane === "stash") return this.stashState?.selectedId
    if (pane === "commits") return this.commitsView()?.selectedId
    if (pane === "branches") {
      const panel = this.branchesPanel
      if (panel.child !== undefined) return panel.child.view.selectedId
      return panel.views[panel.activeTab]?.selectedId
    }
    return undefined
  }
  selectedListRange(pane: "files" | "branches" | "commits" | "stash" | string): { readonly startId?: string; readonly endId?: string; readonly mode: string } {
    if (pane !== "files" && pane !== "branches" && pane !== "commits" && pane !== "stash") return { mode: "none" }
    const state = this.activeListView(pane)?.state
    if (state === undefined) return { mode: "none" }
    return {
      mode: state.rangeMode,
      ...(state.rangeStartId === undefined ? {} : { startId: state.rangeStartId }),
      ...(state.selectedId === undefined ? {} : { endId: state.selectedId }),
    }
  }

  renderedListText(pane: "files" | "branches" | "commits" | "stash" | string): string {
    const getState = (): ListState | undefined => {
      if (pane === "files") return this.filesView()
      if (pane === "stash") return this.stashState
      if (pane === "commits") return this.commitsView()
      if (pane === "branches") {
        const p = this.branchesPanel
        if (p.child !== undefined) return p.child.view
        return p.views[p.activeTab]
      }
      return undefined
    }
    const state = getState()
    if (!state) return ""
    if (state.rows.length === 0) {
      const msg = state.displayRows.find((r) => r.kind === "message")
      return msg ? (msg as { text: string }).text : ""
    }
    return state.rows.map((r) => r.columns.map((c) => c.text).join(" ")).join("\n")
  }

  selectedRowHasBackground(pane: "files" | "branches" | "commits" | "stash" | string): boolean {
    const focused = this.focusManager.active === pane
    if (!focused) return false
    const id = this.selectedListId(pane)
    if (id === undefined) return false
    const state = pane === "files"
      ? this.filesView()
      : pane === "stash"
        ? this.stashState
        : pane === "commits"
          ? this.commitsView()
          : (this.branchesPanel.child?.view ?? this.branchesPanel.views[this.branchesPanel.activeTab as "branches" | "remotes" | "tags"])
    if (!state || state.rows.length === 0) return false
    const winName = pane === "files" ? "files" : pane === "stash" ? "stash" : pane === "commits" ? "commits" : "branches"
    const win = (this.geometry.windows as Record<string, { x0: number; y0: number; x1: number; y1: number } | undefined>)[winName]
    const width = sidePaneListWidth(win, state)
    const content = renderListRows(state, true, width)
    const chunks = (content as unknown as { chunks: readonly unknown[] }).chunks
    return chunks.some((chunk) => {
      if (chunk === null || typeof chunk !== "object") return false
      return "bg" in chunk && (chunk as { bg?: unknown }).bg !== undefined
    })
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
    const selectedFileRow = this.selectedFileRow()
    const mainDocument = getMainDocument(this.panes.main)
    return {
      focus: this.focusManager.active,
      currentSideWindow: this.focusManager.lastSide,
      screenMode: this.geometry.screenMode,
      modal: this.modalInputActive(),
      mainScope: target.kind === "working-tree" ? target.scope : undefined,
      selectedBranchKind: kind,
      commitsTab: this.commitsPanel.activeTab,
      filesTab: this.filesPanel.activeTab,
      hasSelectedStash: this.stashState?.selectedId !== undefined && (this.model.stashes ?? []).some((s) => s.oid === this.stashState.selectedId),
      hasSelectedFile: selectedFileRow?.kind === "file",
      hasMainDocument: mainDocument !== undefined && mainDocument.files.length > 0,
      hasSelectedCommitFile: this.commitsPanel.child !== undefined && this.commitsPanel.child.view.selectedId !== undefined,
    }
  }

  private selectedBranchesItem(): { readonly id: string } | undefined {
    const state = this.branchesPanel.child?.view ?? this.branchesPanel.views[this.branchesPanel.activeTab]
    if (state === undefined || state.rows.length === 0) return undefined
    const id = state.selectedId
    if (id === undefined) return undefined
    return { id }
  }

  /**
   * Panel 3's title strip, as painted on the pane's top border row. Shared with panels that
   * grow tabs later; see src/ui/pane-tabs.ts for the lazygit format it reproduces.
   */
  get branchesTitleStyled(): StyledText {
    const child = this.branchesPanel.child
    if (child !== undefined) return buildPanePlainTitle(BRANCHES_JUMP_KEY, this.branchChildTitle(child.value))
    return buildPaneTabsStrip(this.branchesTabsInput())
  }
  private branchChildTitle(child: BranchesPanelChild): string {
    return child.kind === "local-commits" ? `Commits (${child.branch})` : `Remote branches (${child.remote})`
  }

  private branchesTabsInput(): { jumpKey: string; tabs: readonly string[]; activeIndex: number; focused: boolean } {
    return {
      jumpKey: BRANCHES_JUMP_KEY,
      tabs: BRANCHES_TABS,
      activeIndex: Math.max(0, BRANCHES_TAB_ORDER.indexOf(this.branchesPanel.activeTab)),
      focused: this.focusManager.active === "branches",
    }
  }

  /** Panel 4's title strip; the drill-down child replaces it with a plain dynamic title. */
  get commitsTitleStyled(): StyledText {
    return buildPaneTabsStrip(this.commitsTabsInput())
  }

  private commitsTabsInput(): { jumpKey: string; tabs: readonly string[]; activeIndex: number; focused: boolean } {
    return {
      jumpKey: COMMITS_JUMP_KEY,
      tabs: COMMITS_TABS,
      activeIndex: Math.max(0, COMMITS_TAB_ORDER.indexOf(this.commitsPanel.activeTab)),
      focused: this.focusManager.active === "commits",
    }
  }

  private refreshBranchesPanel(model: AppModel): void {
    const rowOptions = this.branchRowOptions()
    // Lazygit's Branches/Remotes/Tags are separate FilteredListViewModels (pkg/gui/context/*_context.go),
    // each with its own filter. Githunk's branchFilter is the legacy single-query path; the per-tab
    // generic map takes precedence when present so "/" on one tab doesn't hide another's rows.
    const branchesFilter = this.getFilterForKey(this.filterKey("branches", "branches")) || this.branchFilter
    const remotesFilter = this.getFilterForKey(this.filterKey("branches", "remotes")) || this.branchFilter
    const tagsFilter = this.getFilterForKey(this.filterKey("branches", "tags")) || this.branchFilter
    const branchesRows = localBranchRows(model, branchesFilter, rowOptions)
    const remotesRowsData = remoteRows(model, remotesFilter, rowOptions)
    const tagsRowsData = tagRows(model, tagsFilter)
    let panel = this.branchesPanel
    panel = { ...panel, views: { ...panel.views, branches: setListRows(panel.views.branches, branchesRows, branchesRows.length === 0 ? [{ kind: "message", text: "No branches" }] : undefined) } }
    panel = { ...panel, views: { ...panel.views, remotes: setListRows(panel.views.remotes, remotesRowsData, remotesRowsData.length === 0 ? [{ kind: "message", text: "No remotes" }] : undefined) } }
    panel = { ...panel, views: { ...panel.views, tags: setListRows(panel.views.tags, tagsRowsData, tagsRowsData.length === 0 ? [{ kind: "message", text: "No tags" }] : undefined) } }
    if (panel.child !== undefined) {
      if (panel.child.value.kind === "remote-branches") {
        const remote = panel.child.value.remote
        const key = this.filterKey("branches", "remote-branches", remote)
        const filter = this.getFilterForKey(key) || this.branchFilter
        const remoteBranchRowsData = remoteBranchRows(model, remote, filter)
        const nextChildView = setListRows(panel.child.view, remoteBranchRowsData, remoteBranchRowsData.length === 0 ? [{ kind: "message", text: "No branches" }] : undefined)
        panel = { ...panel, child: { ...panel.child, view: nextChildView } }
      } else if (panel.child.value.kind === "local-commits") {
        // SubCommits are searchable (pkg/gui/context/sub_commits_context.go), not filterable.
        // Keep the full commit list and surface the search via bottomTitle/selection.
        const key = this.filterKey("branches", "local-commits", panel.child.value.branch)
        const search = this.getFilterForKey(key)
        // The child's rows are commit rows; reuse the same search-highlight logic as the main
        // commits tab. For now we keep the list unfiltered and let the bottomTitle show the query.
        // If a search is active, the refresh will be triggered via refreshForFilterKey and the
        // child's view will be rebuilt with the search query as a filter for minimal parity.
        // To keep the list filterable for TDD, apply the search as a filter for now.
        const branchCommits = (panel.child.view as unknown as { rows: readonly unknown[] }) // placeholder to avoid unused
        void branchCommits
        void search
        // No-op: the child's view is managed by requestLocalBranchCommits, which already rebuilds
        // the rows. Filtering here would require storing the raw commits; for v0.1 we leave the
        // child unfiltered and rely on bottomTitle feedback.
      }
    }
    this.branchesPanel = panel
  }

  private filterKey(pane: FocusId, tab?: string, child?: string): string {
    if (child !== undefined) return `${pane}:${tab ?? ""}:${child}`
    if (tab !== undefined) return `${pane}:${tab}`
    return pane
  }

  private currentFilterTarget(): { key: string; pane: FocusId; tab?: string; child?: string } | undefined {
    const focus = this.focusManager.active
    if (focus === "files") {
      const tab = this.filesPanel.activeTab
      return { key: this.filterKey("files", tab), pane: "files", tab }
    }
    if (focus === "commits") {
      const child = this.commitsPanel.child
      if (child !== undefined) return { key: this.filterKey("commits", "commit-files", child.value.oid), pane: "commits", tab: "commit-files", child: child.value.oid }
      const tab = this.commitsPanel.activeTab
      return { key: this.filterKey("commits", tab), pane: "commits", tab }
    }
    if (focus === "stash") return { key: this.filterKey("stash"), pane: "stash" }
    if (focus === "main") return { key: this.filterKey("main"), pane: "main" }
    if (focus === "branches") {
      // Branches keep their own branchFilter; still return a key for generic path if needed.
      const child = this.branchesPanel.child
      if (child !== undefined && child.value.kind === "remote-branches") {
        return { key: this.filterKey("branches", "remote-branches", child.value.remote), pane: "branches", tab: "remote-branches", child: child.value.remote }
      }
      if (child !== undefined && child.value.kind === "local-commits") {
        return { key: this.filterKey("branches", "local-commits", child.value.branch), pane: "branches", tab: "local-commits", child: child.value.branch }
      }
      const tab = this.branchesPanel.activeTab
      return { key: this.filterKey("branches", tab), pane: "branches", tab }
    }
    return undefined
  }

  private getFilterForKey(key: string): string {
    return this.filters.get(key) ?? ""
  }

  private filterStatusForHints(): { readonly hints: string; readonly status: string } | undefined {
    const target = this.currentFilterTarget()
    let query: string | undefined
    let isSearch = false
    let isActiveInput = false
    if (target !== undefined) {
      if (target.pane === "branches" && target.child === undefined) {
        if (this.branchFilterActive) {
          query = this.filterInput.state.query
          isActiveInput = true
        } else if (this.branchFilter.length > 0) {
          query = this.branchFilter
        }
        isSearch = false
      } else {
        const key = target.key
        if (this.activeFilterKey === key && this.filterInput.state.active) {
          query = this.filterInput.state.query
          isActiveInput = true
        } else {
          query = this.filters.get(key)
        }
        isSearch = key === this.filterKey("commits", "commits") || key === this.filterKey("main")
      }
    }
    if (query === undefined && this.filterInput.state.active && this.activeFilterKey !== undefined) {
      query = this.filterInput.state.query
      isActiveInput = true
      isSearch = this.activeFilterKey === this.filterKey("commits", "commits") || this.activeFilterKey === this.filterKey("main")
    }
    if (query !== undefined) {
      if (query.length === 0 && !isActiveInput) return undefined
      const prefix = isSearch ? "Search: " : "Filter: "
      const hint = isActiveInput ? " (type, Enter to confirm, Esc to clear)" : " (Esc to clear)"
      // Show a block cursor at the end of the query while actively typing, mirroring lazygit's TextArea cursor.
      const displayQuery = isActiveInput ? `${query}█` : query
      return { hints: `${prefix}${displayQuery}${hint}`, status: "" }
    }
    if (isActiveInput) {
      const prefix = isSearch ? "Search: " : "Filter: "
      return { hints: `${prefix}${this.filterInput.state.query}█ (type, Enter to confirm, Esc to clear)`, status: "" }
    }
    return undefined
  }

  private refreshForFilterKey(key: string): void {
    if (key.startsWith("files:")) this.refreshFilesPanel(this.model)
    else if (key.startsWith("commits:")) this.refreshCommitsPanel(this.model)
    else if (key.startsWith("stash")) this.refreshStashState(this.model)
    else if (key.startsWith("main")) {
      // Main search is handled via viewport highlights; no list refresh needed.
    } else if (key.startsWith("branches:")) this.refreshBranchesPanel(this.model)
  }

  private renderForFilterKey(key: string): void {
    if (key.startsWith("files:")) this.renderFilesPane()
    else if (key.startsWith("commits:")) this.renderCommitsPane()
    else if (key.startsWith("stash")) this.renderStashPane()
    else if (key.startsWith("main")) this.root.requestRender()
    else if (key.startsWith("branches:")) this.renderBranchesPane()
  }

  private renderBranchesPane(): void {
    const pane = this.panes.branches
    const child = this.branchesPanel.child
    if (child === undefined) {
      const tabsInput = this.branchesTabsInput()
      pane.setTabs?.({ activeIndex: tabsInput.activeIndex, focused: tabsInput.focused })
    } else {
      pane.setPlainTitle?.(`[${BRANCHES_JUMP_KEY}]${TITLE_PREFIX_FRAME_RUNE}${this.branchChildTitle(child.value)}`)
    }
    const focused = this.focusManager.active === "branches"
    const activeView = this.activeListView("branches")
    if (activeView === undefined) {
      pane.update("")
      return
    }
    const { state } = activeView
    const win = this.geometry.windows.branches
    const width = sidePaneListWidth(win, state)
    const content = renderListRows(state, focused, width, this.hoveredIdFor(activeView))
    pane.update(content)
    pane.syncScrollbar(sidePaneViewportHeight(win))
  }

  /** Panel 2's title strip; see src/ui/pane-tabs.ts for the lazygit format it reproduces. */
  get filesTitleStyled(): StyledText {
    return buildPaneTabsStrip(this.filesTabsInput())
  }

  private filesTabsInput(): { jumpKey: string; tabs: readonly string[]; activeIndex: number; focused: boolean } {
    return {
      jumpKey: FILES_JUMP_KEY,
      tabs: FILES_TABS,
      activeIndex: Math.max(0, FILES_TAB_ORDER.indexOf(this.filesPanel.activeTab)),
      focused: this.focusManager.active === "files",
    }
  }

  /** The Files tab's view, re-rendered from `this.filesTree` — the one place its rows are built. */
  private filesTabView(model: AppModel): ListState {
    const rawRows = filesTreeRows(this.filesTree, model)
    const filter = this.getFilterForKey(this.filterKey("files", "files"))
    const rows = filter.length === 0 ? rawRows : [...filterItems(filter, rawRows, (row) => `${row.id} ${row.columns[1]?.text ?? ""}`)]
    const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: NO_CHANGED_FILES }] : undefined
    return setListRows(this.filesPanel.views.files, rows, displayRows)
  }

  private refreshFilesPanel(model: AppModel): void {
    this.filesTree = setFileTreeItems(this.filesTree, model.files)
    let filesView = this.filesTabView(model)
    if (model.focusId !== undefined) {
      // The controller tracks a logical path; tree rows may carry the root item's `./` prefix.
      const focusRowId = fileTreeRows(this.filesTree).find((row) => row.kind === "file" && row.path === model.focusId)?.id
      if (
        focusRowId !== undefined &&
        filesView.rows.some((row) => row.id === focusRowId) &&
        filesView.rangeMode === "none" &&
        filesView.rangeStartId === undefined
      ) {
        const withFocus = selectListRow(filesView, focusRowId)
        if (withFocus.selectedId === focusRowId) filesView = withFocus
      }
    }
    let panel = updatePanelView(this.filesPanel, "files", filesView)
    const worktreesFilter = this.getFilterForKey(this.filterKey("files", "worktrees"))
    const worktreesRaw = worktreeRows(model)
    const worktrees = worktreesFilter.length === 0 ? worktreesRaw : [...filterItems(worktreesFilter, worktreesRaw, (row) => `${row.columns[1]?.text ?? ""} ${row.columns[2]?.text ?? ""} ${row.id}`)]
    panel = updatePanelView(panel, "worktrees", setListRows(panel.views.worktrees, worktrees, worktrees.length === 0 ? [{ kind: "message", text: NO_WORKTREES_THIS_REPO }] : undefined))
    const submodulesFilter = this.getFilterForKey(this.filterKey("files", "submodules"))
    const submodulesRaw = submoduleRows(model)
    const submodules = submodulesFilter.length === 0 ? submodulesRaw : [...filterItems(submodulesFilter, submodulesRaw, (row) => row.columns[0]?.text ?? row.id)]
    panel = updatePanelView(panel, "submodules", setListRows(panel.views.submodules, submodules, submodules.length === 0 ? [{ kind: "message", text: NO_SUBMODULES }] : undefined))
    this.filesPanel = panel
  }

  /** Re-renders the Files tab after a tree mutation (collapse, flat/tree mode). */
  private applyFilesTree(next: FileTreeState<ChangedFile>): void {
    this.filesTree = next
    this.filesPanel = updatePanelView(this.filesPanel, "files", this.filesTabView(this.model))
    this.renderFilesPane()
    this.root.requestRender()
  }

  private renderFilesPane(): void {
    const pane = this.panes.files
    const tabsInput = this.filesTabsInput()
    pane.setTabs?.({ tabs: tabsInput.tabs, activeIndex: tabsInput.activeIndex, focused: tabsInput.focused })
    const activeView = this.activeListView("files")
    if (activeView === undefined) {
      pane.update("")
      return
    }
    const { state } = activeView
    const win = this.geometry.windows.files
    const width = sidePaneListWidth(win, state)
    pane.update(renderListRows(state, tabsInput.focused, width, this.hoveredIdFor(activeView)))
    pane.syncScrollbar(sidePaneViewportHeight(win))
  }

  private refreshStashState(model: AppModel): void {
    const filter = this.getFilterForKey(this.filterKey("stash"))
    const rows = stashRows(model, filter)
    const text = model.reviewTarget.kind === "stash" ? `* ${model.reviewTarget.ref}` : "No stashes"
    const displayRows = rows.length === 0 ? [{ kind: "message" as const, text }] : undefined
    this.stashState = setListRows(this.stashState, rows, displayRows)
  }

  private renderStashPane(): void {
    const pane = this.panes.stash
    const activeView = this.activeListView("stash")
    if (activeView === undefined) {
      pane.update("")
      return
    }
    const { state } = activeView
    const focused = this.focusManager.active === "stash"
    const win = this.geometry.windows.stash
    const width = sidePaneListWidth(win, state)
    const content = renderListRows(state, focused, width, this.hoveredIdFor(activeView))
    pane.update(content)
    pane.syncScrollbar(sidePaneViewportHeight(win))
  }
  private renderSidePanes(): void {
    this.renderBranchesPane()
    this.renderCommitsPane()
    this.renderFilesPane()
    this.renderStashPane()
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
      case "command-log": this.openCommandLogMenu(); return
      case "pane-next": this.focusManager.cycle("next"); return
      case "pane-previous": this.focusManager.cycle("previous"); return
      case "next": this.actionMoveCursor("next"); return
      case "previous": this.actionMoveCursor("previous"); return
      case "toggle-range-select": this.actionToggleRangeSelection(); return
      case "range-select-up": this.actionExpandRangeSelection("previous"); return
      case "range-select-down": this.actionExpandRangeSelection("next"); return
      case "stage-file": this.actionStageFile(); return
      case "discard-file": this.actionDiscardFile(); return
      case "stage-all": this.actionStageAll(); return
      case "mark-reviewed": this.actionMarkReviewed(); return
      case "edit-file": void this.actionEditFile(); return
      case "inspect": this.actionInspect(); return
      case "stage-selection": this.actionStageSelection(); return
      case "discard-selection": this.actionDiscardSelection(); return
      case "toggle-file-tree": this.actionToggleFileTree(); return
      case "collapse-files": this.actionCollapseAllFiles(); return
      case "expand-files": this.actionExpandAllFiles(); return
      case "tab-next": this.actionCycleTab("next"); return
      case "tab-previous": this.actionCycleTab("previous"); return
      case "branch-checkout": this.actionBranchCheckout(); return
      case "branch-create": this.actionBranchCreate(); return
      case "branch-delete": this.actionBranchDelete(); return
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
      case "scope-next": this.actionScopeCycle("next"); return
      case "scope-previous": this.actionScopeCycle("previous"); return
      case "fetch": this.actionFetch(); return
      case "pull": this.actionPull(); return
      case "push": this.actionPush(); return
      case "refresh": this.actionRefresh(); return
      case "open-branch-review": this.actionOpenBranchReview(); return
      case "filter": this.actionFilter(); return
      case "search-next": this.actionSearchNext(); return
      case "search-previous": this.actionSearchPrevious(); return
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
      case "main-scroll-down": this.clearNonStickyMainRange(); scrollMainPane(this.panes.main, "y", MAIN_SCROLL_HEIGHT); this.root.requestRender(); return
      case "main-scroll-up": this.clearNonStickyMainRange(); scrollMainPane(this.panes.main, "y", -MAIN_SCROLL_HEIGHT); this.root.requestRender(); return
      case "main-scroll-right": this.clearNonStickyMainRange(); scrollMainPane(this.panes.main, "x", 4); this.root.requestRender(); return
      case "main-scroll-left": this.clearNonStickyMainRange(); scrollMainPane(this.panes.main, "x", -4); this.root.requestRender(); return
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
    if (this.actionMenu.isOpen()) {
      // `key.name` is already githunk's canonical name here (RootView.handleKey normalizes
      // before routing to the modal path, keymap.ts:31-33), so only "enter" is live — "return"
      // in action-menu.ts:105 exists for callers that dispatch raw OpenTUI key names.
      const wasCopyMenu = this.copyMenuOpen && this.actionMenu.box.title === "Copy"
      const wasUpstream = (this.actionMenu.box.title ?? "").startsWith("Upstream")
      const wasPendingMismatch = this.actionMenu.box.title === "Remote tracking mismatch"
      if (this.actionMenu.handleKey(key.name)) {
        this.recomputeLayout()
        if (wasCopyMenu && !this.actionMenu.isOpen()) this.copyMenuOpen = false
        if (wasUpstream && !this.actionMenu.isOpen() && key.name === "escape" && this.onCancelUpstream !== undefined) {
          this.runUiMutation(() => this.onCancelUpstream!())
        }
        if (wasPendingMismatch && !this.actionMenu.isOpen()) {
          if (key.name === "escape") this.actionBack()
          else if (key.name !== "escape") this.pendingRemoteMismatch = undefined
        }
        return
      }
    }
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
    if (this.filterInput.state.active && this.activeFilterKey !== undefined) {
      this.handleGenericFilterKey(key)
      return
    }
    if (this.commitMessagePanel.visible) {
      if (this.mutationInFlight) return
      this.handleCommitMessagePanelKey(key)
      return
    }
    if (this.commitDialog !== undefined) {
      const mode = this.commitDialog.state.mode
      if (mode === "stash") {
        if (this.mutationInFlight) return
        if (key.name === "u" && key.ctrl === true && !key.meta) {
          this.stashIncludeUntracked = !this.stashIncludeUntracked
          this.promptPopup.update(this.commitDialog.state, `Include untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`)
          this.recomputeLayout()
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
    // A pending remote-tracking mismatch remains modal until the user confirms with Enter or
    // cancels with Escape. All action menus are handled above, so no destructive key may fall
    // through to the focused pane while a modal is active.
    if (key.name === "escape") {
      this.actionBack()
      return
    }
    if (key.name === "enter" && this.pendingRemoteMismatch !== undefined && this.focusManager.active === "branches") {
      this.actionBranchInspect()
    }
  }

  private handleFilterKey(key: KeyEvent): boolean {
    this.branchActionGeneration += 1
    if (!this.branchFilterActive) return false
    const result = this.filterInput.handleKey(key)
    if (result.cancelled) {
      this.invalidateRemoteCheckout()
      this.branchFilter = ""
      this.filterInput.clear()
    } else {
      this.branchFilter = this.filterInput.state.query
    }
    this.branchFilterActive = this.filterInput.state.active
    this.refreshBranchesPanel(this.model)
    this.renderBranchesPane()
    this.recomputeLayout()
    return result.consumed
  }

  private handleGenericFilterKey(key: KeyEvent): boolean {

    if (this.activeFilterKey === undefined) return false
    const activeKey = this.activeFilterKey
    const result = this.filterInput.handleKey(key)
    if (result.cancelled) {
      this.filters.delete(activeKey)
      this.filterInput.clear()
      this.filterInput.close()
      this.activeFilterKey = undefined
    } else {
      const query = this.filterInput.state.query
      if (query.length === 0) this.filters.delete(activeKey)
      else this.filters.set(activeKey, query)
      if (!this.filterInput.state.active) {
        // Enter confirmed – keep query but close editing
        this.activeFilterKey = undefined
      }
    }
    this.refreshForFilterKey(activeKey)
    this.renderForFilterKey(activeKey)
    this.recomputeLayout()
    return result.consumed
  }
  private updateActiveListState(paneId: ListPaneId, state: ListState): void {
    if (paneId === "files") {
      this.filesPanel = updatePanelView(this.filesPanel, this.filesPanel.activeTab, state)
      return
    }
    if (paneId === "branches") {
      this.branchActionGeneration += 1
      this.invalidateBranchCommitsRequest()
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      if (this.branchesPanel.child !== undefined) {
        this.branchesPanel = { ...this.branchesPanel, child: { ...this.branchesPanel.child, view: state } }
      } else {
        const active = this.branchesPanel.activeTab
        this.branchesPanel = { ...this.branchesPanel, views: { ...this.branchesPanel.views, [active]: state } }
      }
      return
    }
    if (paneId === "commits") {
      if (this.commitsPanel.child !== undefined) {
        this.commitsPanel = { ...this.commitsPanel, child: { ...this.commitsPanel.child, view: state } }
      } else {
        this.commitsPanel = updatePanelView(this.commitsPanel, this.commitsPanel.activeTab, state)
      }
      return
    }
    this.stashState = state
  }
  private syncListSelectionAfterChange(paneId: ListPaneId): void {
    if (paneId !== "files" || this.filesPanel.activeTab !== "files") {
      this.syncPreviewForFocus(paneId)
      return
    }
    const row = this.selectedFileRow()
    this.panes.files.box.bottomTitle = row?.path ?? "No files"
    // A directory is not a review target: telling the controller about it would file a
    // review status under a path that is not a file.
    if (row?.kind === "file") this.onSelectFile?.(row.path)
    this.mainGate.installSynchronous(this.presentFilesContent(this.model))
  }

  private actionToggleRangeSelection(): void {
    if (this.focusManager.active === "main") {
      const state = getMainDiffLineRangeState(this.panes.main)
      if (state === undefined) return
      const next = toggleDiffLineRange(state)
      if (next === state) return
      setMainDiffLineRangeState(this.panes.main, next)
      this.revealMainDiffRange(next.selectedIndex)
      return
    }
    const paneId = this.focusManager.active
    if (paneId !== "files" && paneId !== "branches" && paneId !== "commits" && paneId !== "stash") return
    const active = this.activeListView(paneId)
    if (active === undefined) return
    const next = toggleListRangeSelection(active.state)
    if (next === active.state) return
    this.updateActiveListState(paneId, next)
    this.renderListPane(paneId)
    this.revealListRow(paneId, this.panes[paneId], next.selectedIndex)
    this.syncListSelectionAfterChange(paneId)
    this.root.requestRender()
  }

  private actionExpandRangeSelection(direction: "next" | "previous"): void {
    if (this.focusManager.active === "main") {
      const state = getMainDiffLineRangeState(this.panes.main)
      if (state === undefined) return
      const next = expandDiffLineRange(state, direction)
      if (next === state) return
      setMainDiffLineRangeState(this.panes.main, next)
      this.revealMainDiffRange(next.selectedIndex)
      return
    }
    const paneId = this.focusManager.active
    if (paneId !== "files" && paneId !== "branches" && paneId !== "commits" && paneId !== "stash") return
    const active = this.activeListView(paneId)
    if (active === undefined) return
    const next = expandListRangeSelection(active.state, direction)
    if (next === active.state) return
    this.updateActiveListState(paneId, next)
    this.renderListPane(paneId)
    this.revealListRow(paneId, this.panes[paneId], next.selectedIndex)
    this.syncListSelectionAfterChange(paneId)
    this.root.requestRender()
  }


  private actionMoveCursor(direction: "next" | "previous"): void {
    switch (this.focusManager.active) {
      case "files": {
        this.clearTransientMenus()
        const panel = this.filesPanel
        const active = panel.activeTab
        const current = panel.views[active]
        if (current === undefined) return
        const next = moveListSelection(current, direction)
        if (next === current) return
        this.filesPanel = updatePanelView(panel, active, next)
        this.renderFilesPane()
        this.revealListRow("files", this.panes.files, next.selectedIndex)
        if (active !== "files") {
          this.syncPreviewForFocus("files")
          this.root.requestRender()
          return
        }
        const row = this.selectedFileRow()
        this.panes.files.box.bottomTitle = row?.path ?? "No files"
        // A directory is not a review target: telling the controller about it would file a
        // review status under a path that is not a file.
        if (row?.kind === "file") this.onSelectFile?.(row.path)
        this.mainGate.installSynchronous(this.presentFilesContent(this.model))
        this.root.requestRender()
        return
      }
      case "branches": {
        this.branchActionGeneration += 1
        this.invalidateBranchCommitsRequest()
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
          const active = panel.activeTab
          const currentView = panel.views[active]!
          const nextView = moveListSelection(currentView, direction)
          if (nextView !== currentView) {
            this.commitsPanel = updatePanelView(panel, active, nextView)
            this.renderCommitsPane()
            this.revealListRow("commits", this.panes.commits, nextView.selectedIndex)
            this.syncPreviewForFocus("commits")
          }
        }
        return
      }
      case "stash": {
        const next = moveListSelection(this.stashState, direction)
        if (next !== this.stashState) {
          this.stashState = next
          this.renderStashPane()
          this.revealListRow("stash", this.panes.stash, next.selectedIndex)
          this.syncPreviewForFocus("stash")
        }
        return
      }
      case "main": {
        // One line, like lazygit's `ViewSelectionController.handleLineChange(±1)`
        // (pkg/gui/controllers/view_selection_controller.go:53-70). The line-range cursor is
        // separate from the hunk cursor used by `h`/`l`; ordinary movement still scrolls exactly
        // one row, while non-sticky keyboard ranges cancel before the scroll.
        const state = getMainDiffLineRangeState(this.panes.main)
        let movedSticky = false
        let endpoint: number | undefined
        if (state !== undefined) {
          const next = moveDiffLineSelection(state, direction)
          movedSticky = state.rangeMode === "sticky" && next !== state
          endpoint = next.selectedIndex
          if (next !== state) setMainDiffLineRangeState(this.panes.main, next)
        }
        this.scrollMainBy(direction === "next" ? 1 : -1)
        if (movedSticky && endpoint !== undefined) this.revealMainDiffRange(endpoint)
        return
      }
      case "command-log":
        // `scrollUpExtra`/`scrollDownExtra` (pkg/gui/keybindings.go:249-258) scroll one line and
        // both clear `Autoscroll`, even scrolling down (pkg/gui/extras_panel.go:49,57) — holding
        // `j` to the bottom does not re-arm it, only `>` does.
        this.commandLog.scrollBy(direction === "next" ? 1 : -1)
        this.commandLog.applyScrollInput(direction === "next" ? "scroll-down" : "scroll-up")
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
   * source focusedPageStep and mainPageDelta already trust).
   */
  private revealListRow(name: SideWindow | "main", pane: PaneHandle, line: number): void {
    const visibleLines = Math.max(1, heightOf(this.geometry.windows[name]) - 2)
    pane.text.scrollY = scrollYToReveal(line, line, visibleLines, pane.text.scrollY)
    // No scroll-change event exists in OpenTUI 0.5.6: without this the thumb freezes
    // whenever a reveal mutates scrollY without a content update.
    pane.syncScrollbar()
  }

  /**
   * lazygit's `ViewTrait.PageDelta()`: one row short of the viewport, so a page scroll leaves a
   * line of overlap to read against (pkg/gui/context/view_trait.go:87-96). The window height
   * includes both border rows, hence the extra one.
   */
  get mainPageDelta(): number {
    return Math.max(1, heightOf(this.geometry.windows.main) - 3)
  }
  private revealMainDiffRange(endpointIndex?: number): void {
    const state = getMainDiffLineRangeState(this.panes.main)
    if (state === undefined) return
    const range = diffLineSelectionRange(state)
    const endpoint = endpointIndex === undefined ? range.endIndex : endpointIndex
    const rows = mainDiffVisualRowRange(this.panes.main, endpoint, endpoint)
      ?? mainDiffVisualRowRange(this.panes.main, range.startIndex, range.endIndex)
    if (rows === undefined) return
    const visibleLines = Math.max(1, heightOf(this.geometry.windows.main) - 2)
    this.panes.main.text.scrollY = scrollYToReveal(rows.startRow, rows.endRow, visibleLines, this.panes.main.text.scrollY)
    this.panes.main.syncScrollbar()
  }

  /** Every keyboard path that scrolls the main view vertically ends here. */
  private clearNonStickyMainRange(): void {
    const state = getMainDiffLineRangeState(this.panes.main)
    if (state?.rangeMode !== "non-sticky") return
    setMainDiffLineRangeState(this.panes.main, clearDiffLineRange(state))
  }

  private scrollMainBy(delta: number): void {
    this.clearNonStickyMainRange()
    scrollMainPane(this.panes.main, "y", delta)
    this.root.requestRender()
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
    if (this.focusManager.active === "main") {
      // `ViewSelectionController.handlePrevPage`/`handleNextPage` — view_selection_controller.go:72-78.
      this.scrollMainBy(direction === "next" ? this.mainPageDelta : -this.mainPageDelta)
      return
    }
    const step = this.focusedPageStep()
    if (this.focusManager.active === "command-log") {
      // `pageUpExtrasPanel`/`pageDownExtrasPanel` scroll by `PageDelta()` — the pane's visible
      // height — and both clear `Autoscroll` (pkg/gui/extras_panel.go:65,73, view_trait.go:87-96).
      this.commandLog.scrollBy(direction === "next" ? step : -step)
      this.commandLog.applyScrollInput(direction === "next" ? "page-down" : "page-up")
      return
    }
    for (let moved = 0; moved < step; moved += 1) this.actionMoveCursor(direction)
  }

  private actionJump(edge: "top" | "bottom"): void {
    if (this.focusManager.active === "main") {
      // `handleGotoTop`/`handleGotoBottom` scroll by the whole content height, which the pane's
      // own clamping turns into "as far as it goes" — view_selection_controller.go:81-97.
      this.scrollMainBy(edge === "bottom" ? this.panes.main.text.scrollHeight : -this.panes.main.text.scrollHeight)
      return
    }
    if (this.focusManager.active === "command-log") {
      // `goToExtrasPanelTop` scrolls to 0 and clears `Autoscroll` (pkg/gui/extras_panel.go:81,89);
      // `goToExtrasPanelBottom` sets it instead, and the pane re-pins to the bottom once armed, so
      // no separate scroll call is needed here.
      if (edge === "top") {
        this.commandLog.scrollTo(0)
        this.commandLog.applyScrollInput("goto-top")
      } else {
        this.commandLog.applyScrollInput("goto-bottom")
      }
      return
    }
    // Lists are short enough that repeating the single-step move is simpler
    // and cannot disagree with it about clamping or selection side effects.
    const direction = edge === "bottom" ? "next" : "previous"
    const branchCount = this.branchesPanel.child !== undefined
      ? this.branchesPanel.child.view.rows.length
      : this.branchesPanel.views[this.branchesPanel.activeTab]?.rows.length ?? 0
    const limit = Math.max(
      this.model.files.length,
      (this.model.worktrees ?? []).length,
      (this.model.submodules ?? []).length,
      (this.model.commits ?? []).length,
      (this.model.stashes ?? []).length,
      (this.model.reflog ?? []).length,
      branchCount,
    ) + 1
    for (let moved = 0; moved < limit; moved += 1) this.actionMoveCursor(direction)
  }


  private actionInspect(): void {
    switch (this.focusManager.active) {
      case "files": {
        // The Worktrees and Submodules tabs are navigation-only; lazygit's Enter there switches
        // worktree or enters the submodule repository, both of which change the repository
        // wholesale and are out of scope.
        if (this.filesPanel.activeTab !== "files") return
        const row = this.selectedFileRow()
        // files_controller.go:715 EnterFile: a node with no file toggles its collapsed state.
        if (row?.kind === "directory") {
          this.applyFilesTree(toggleFileTreeCollapsedPath(this.filesTree, row.internalPath))
          return
        }
        this.actionOpenFile()
        return
      }
      case "branches":
        this.actionBranchInspect()
        return
      default:
        return
    }
  }

  private actionOpenFile(): void {
    if (this.mutationInFlight) return
    const row = this.selectedFileRow()
    if (row?.kind === "file") this.onSelectFile?.(row.path)
    this.focusManager.focus("main")
  }

  private actionStageFile(): void {
    if (this.mutationInFlight) return
    const row = this.selectedFileRow()
    if (row === undefined) return
    if (row.kind === "directory") {
      // files_controller.go:509 toggleStaged: stage when any file within has unstaged changes,
      // otherwise unstage. git resolves a directory pathspec across the subtree itself, so the
      // single-path callbacks carry it unchanged.
      const stage = someFileInNode(row.node, fileHasUnstagedChanges)
      const operation = stage ? this.onStageFile : this.onUnstageFile
      if (operation !== undefined) this.runUiMutation(() => operation(row.path))
      return
    }
    const file = row.payload
    if (file === undefined) return
    const staged = !file.untracked && file.worktreeStatus === "." && file.indexStatus !== "."
    const operation = staged ? this.onUnstageFile : this.onStageFile
    if (operation !== undefined) this.runUiMutation(() => operation(file.path))
  }

  private actionDiscardFile(): void {
    if (this.mutationInFlight) return
    const row = this.selectedFileRow()
    if (row === undefined || this.onDiscardFile === undefined) return
    const path = row.path
    const hasStaged = row.kind === "directory"
      ? someFileInNode(row.node, fileHasStagedChanges)
      : row.payload !== undefined && fileHasStagedChanges(row.payload)
    const hasUnstaged = row.kind === "directory"
      ? someFileInNode(row.node, fileHasUnstagedChanges)
      : row.payload !== undefined && fileHasUnstagedChanges(row.payload)
    const unstagedReason = !hasStaged || !hasUnstaged
      ? "The selected items don't have both staged and unstaged changes."
      : undefined
    this.actionMenu.openMenu("Discard changes", [
      {
        key: "x",
        label: "Discard all changes",
        onPress: () => this.runUiMutation(() => this.onDiscardFile?.(path, "all")),
      },
      {
        key: "u",
        label: "Discard unstaged changes",
        onPress: () => this.runUiMutation(() => this.onDiscardFile?.(path, "unstaged")),
        ...(unstagedReason === undefined ? {} : { disabledReason: unstagedReason }),
      },
    ])
    this.recomputeLayout()
  }

  private actionStageAll(): void {
    if (this.mutationInFlight) {
      this.panes.main.box.bottomTitle = "Mutation in progress; wait for refresh"
      return
    }
    if (this.onToggleAllFiles === undefined) return
    this.runUiMutation(() => this.onToggleAllFiles!())
  }

  private actionMarkReviewed(): void {
    if (this.mutationInFlight) return
    if (this.onMarkFocusedFileReviewed === undefined) return
    const row = this.selectedFileRow()
    // Review progress is githunk's own, per-file, and the controller only takes one path (and
    // falls back to the first changed file when the path is not one), so a directory row cannot
    // express "mark this subtree reviewed" — say so rather than marking the wrong file.
    if (row?.kind === "directory") {
      this.panes.files.box.bottomTitle = "Mark reviewed applies to a file; select a file row"
      return
    }
    const file = row?.payload
    const focusedPath = this.model.focusId ?? this.model.selectionId
    const reviewPath = focusedPath !== undefined && this.model.files.some((candidate) => candidate.path === focusedPath)
      ? focusedPath
      : file?.path
    this.runUiMutation(() => this.onMarkFocusedFileReviewed!(reviewPath))
  }
  /**
   * Opens the selected file in an external editor, mirroring lazygit's
   * `Universal.Edit` (`e`) binding across Files, Staging and Commit Files
   * (pkg/gui/controllers/files_controller.go:91, staging_controller.go:63,
   * commits_files_controller.go:77, etc.). The Files pane edits the
   * selected file, the Main pane edits the file at the hunk cursor (with
   * `+line` when available), and the Commits drill-down edits the selected
   * commit file. Directories are rejected explicitly, matching lazygit's
   * `canEditFiles` guard.
   */
  private async actionEditFile(): Promise<void> {
    if (this.mutationInFlight) return
    if (this.onEditFile === undefined) {
      const focus = this.focusManager.active
      const box = focus === "files" ? this.panes.files.box : focus === "main" ? this.panes.main.box : focus === "commits" ? this.panes.commits.box : this.panes.main.box
      box.bottomTitle = "Edit not available in this context"
      return
    }
    const focus = this.focusManager.active
    if (focus === "files") {
      if (this.filesPanel.activeTab !== "files") {
        this.panes.files.box.bottomTitle = "Edit is available in the Files tab"
        return
      }
      const row = this.selectedFileRow()
      if (row === undefined) {
        this.panes.files.box.bottomTitle = "No file selected"
        return
      }
      if (row.kind === "directory") {
        this.panes.files.box.bottomTitle = "Cannot edit a directory; select a file"
        return
      }
      const path = row.path
      this.mutationInFlight = true
      this.clearTransientMenus()
      this.panes.files.box.bottomTitle = `Opening ${path}…`
      try {
        await this.onEditFile(path)
        this.panes.files.box.bottomTitle = undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.panes.files.box.bottomTitle = message
      } finally {
        this.mutationInFlight = false
        this.onMutationSettled?.()
        this.root.requestRender()
      }
      return
    }
    if (focus === "main") {
      const document = getMainDocument(this.panes.main)
      if (document === undefined || document.files.length === 0) {
        this.panes.main.box.bottomTitle = "No file in main view"
        return
      }
      const target = getMainCursorTarget(this.panes.main)
      let filePath: string | undefined
      let line: number | undefined
      if (target !== undefined) {
        const file = document.files[target.fileIndex]
        if (file !== undefined) {
          filePath = file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
          if (filePath !== undefined && target.hunkIndex !== undefined) {
            const hunk = file.hunks[target.hunkIndex]
            if (hunk !== undefined) line = hunk.newStart
          }
        }
      }
      if (filePath === undefined || filePath === "/dev/null") {
        const fallbackRow = this.selectedFileRow()
        if (fallbackRow?.kind === "file") filePath = fallbackRow.path
        else filePath = document.files[0]?.newPath ?? document.files[0]?.oldPath
      }
      if (line === undefined && filePath !== undefined) {
        const fileForLine = document.files.find((candidate) => (candidate.newPath ?? candidate.oldPath) === filePath) ?? document.files[0]
        const firstHunk = fileForLine?.hunks[0]
        if (firstHunk !== undefined) line = firstHunk.newStart
      }
      if (filePath === undefined || filePath === "/dev/null" || filePath.length === 0) {
        this.panes.main.box.bottomTitle = "No file to edit"
        return
      }
      this.mutationInFlight = true
      this.clearTransientMenus()
      this.panes.main.box.bottomTitle = `Opening ${filePath}${line !== undefined ? `:${line}` : ""}…`
      try {
        await this.onEditFile(filePath, line)
        this.panes.main.box.bottomTitle = undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.panes.main.box.bottomTitle = message
      } finally {
        this.mutationInFlight = false
        this.onMutationSettled?.()
        this.root.requestRender()
      }
      return
    }
    if (focus === "commits") {
      if (this.commitsPanel.child === undefined) {
        this.panes.commits.box.bottomTitle = "Edit is available in commit files view (press Enter on a commit)"
        return
      }
      const selectedId = this.commitsPanel.child.view.selectedId
      if (selectedId === undefined) {
        this.panes.commits.box.bottomTitle = "No file selected"
        return
      }
      const filePath = selectedId.split("\u0000")[0]
      if (filePath === undefined || filePath.length === 0 || filePath === "/dev/null") {
        this.panes.commits.box.bottomTitle = "Cannot edit this entry"
        return
      }
      this.mutationInFlight = true
      this.clearTransientMenus()
      this.panes.commits.box.bottomTitle = `Opening ${filePath}…`
      try {
        await this.onEditFile(filePath)
        this.panes.commits.box.bottomTitle = undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.panes.commits.box.bottomTitle = message
      } finally {
        this.mutationInFlight = false
        this.onMutationSettled?.()
        this.root.requestRender()
      }
      return
    }
    this.panes.main.box.bottomTitle = "Edit not available in this panel"
  }
  private actionStageSelection(): void {
    if (this.mutationInFlight) return
    if (this.onApplySelection === undefined) return
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all") {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press ] to choose staged or unstaged"
      return
    }
    const selected = this.mainChangeSelection()
    const document = getMainDocument(this.panes.main)
    const target = document === undefined ? undefined : this.mainActionTarget(document)
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
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all") {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press ] to choose staged or unstaged"
      return
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged") {
      this.panes.main.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
      return
    }
    const selected = this.mainChangeSelection()
    const document = getMainDocument(this.panes.main)
    const target = document === undefined ? undefined : this.mainActionTarget(document)
    const targetFile = target === undefined || document === undefined ? undefined : document.files[target.fileIndex]
    const path = targetFile?.newPath !== undefined && targetFile.newPath !== "/dev/null" ? targetFile.newPath : targetFile?.oldPath ?? "selected changes"
    const modelFile = this.model.files.find((file) => file.path === path)
    if (modelFile?.untracked && this.onDiscardFile !== undefined) {
      this.openConfirmation(discardConfirmation(path, true), () => this.runUiMutation(() => this.onDiscardFile?.(path, "all")))
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
      return
    }
    const paths = this.selectionPaths(selected.document, selected.indexes)
    const label = paths.join(", ")
    this.openConfirmation(
      discardConfirmation(label || path),
      () => this.runUiMutation(() => this.onDiscardSelection!(selected.document, selected.indexes)),
    )
  }


  /** lazygit's `` ` `` binding — files_controller.go:1502 toggleTreeView. */
  private actionToggleFileTree(): void {
    if (this.filesPanel.activeTab !== "files") return
    this.applyFilesTree(toggleFileTreeMode(this.filesTree))
  }

  /** lazygit's `-` binding — files_controller.go:698 collapseAll. */
  private actionCollapseAllFiles(): void {
    if (this.filesPanel.activeTab !== "files") return
    this.applyFilesTree(collapseAllFileTree(this.filesTree))
  }

  /** lazygit's `=` binding — files_controller.go:706 expandAll. */
  private actionExpandAllFiles(): void {
    if (this.filesPanel.activeTab !== "files") return
    this.applyFilesTree(expandAllFileTree(this.filesTree))
  }

  /**
   * The tab strip painted on `paneId`'s top border row, or undefined for a pane without tabs.
   * Panels that grow tabs register them here (and in their `createPane` options).
   */
  private paneTabsGeometryFor(paneId: FocusId): { readonly jumpKey: string; readonly tabs: readonly string[] } | undefined {
    if (paneId === "files") return { jumpKey: FILES_JUMP_KEY, tabs: FILES_TABS }
    if (paneId === "branches") return this.branchesPanel.child === undefined ? { jumpKey: BRANCHES_JUMP_KEY, tabs: BRANCHES_TABS } : undefined
    // The drill-down child replaces the strip with a plain title, so there is nothing to hit.
    if (paneId === "commits") return this.commitsPanel.child !== undefined ? undefined : { jumpKey: COMMITS_JUMP_KEY, tabs: COMMITS_TABS }
    return undefined
  }

  /** Activates a tab by index, as a click on the title row does (gocui/gui.go:1807). */
  private selectPaneTab(paneId: FocusId, index: number): void {
    if (paneId === "files") {
      const tab = FILES_TAB_ORDER[index]
      if (tab === undefined || this.filesPanel.activeTab === tab) return
      this.filesPanel = { ...this.filesPanel, activeTab: tab }
      this.renderFilesPane()
      this.syncPreviewForFocus("files")
      this.root.requestRender()
      return
    }
    if (paneId === "branches") {
      const tab = BRANCHES_TAB_ORDER[index]
      if (tab === undefined) return
      if (this.branchesPanel.child === undefined && this.branchesPanel.activeTab === tab) return
      this.branchActionGeneration += 1
      this.invalidateBranchCommitsRequest()
      this.branchesPanel = { ...leavePanelChild(this.branchesPanel), activeTab: tab }
      this.renderBranchesPane()
      this.syncPreviewForFocus("branches")
      this.root.requestRender()
      return
    }
    if (paneId === "commits") {
      const tab = COMMITS_TAB_ORDER[index]
      if (tab === undefined) return
      if (this.commitsPanel.child === undefined && this.commitsPanel.activeTab === tab) return
      this.commitsPanel = { ...leavePanelChild(this.commitsPanel), activeTab: tab }
      this.renderCommitsPane()
      this.syncPreviewForFocus("commits")
      this.root.requestRender()
    }
  }

  private actionCycleTab(direction: "next" | "previous"): void {
    if (this.focusManager.active === "files") {
      this.filesPanel = cyclePanelTab(this.filesPanel, direction)
      this.clearTransientMenus()
      this.renderFilesPane()
      // Activating a context renders it to main (pkg/gui/context.go `Activate` -> HandleFocus).
      this.syncPreviewForFocus("files")
      this.root.requestRender()
      return
    }
    if (this.focusManager.active === "branches") {
      this.branchActionGeneration += 1
      this.invalidateBranchCommitsRequest()
      this.branchesPanel = cyclePanelTab(this.branchesPanel, direction)
      this.renderBranchesPane()
      // Activating a context renders it to main (pkg/gui/context.go `Activate` -> HandleFocus).
      this.syncPreviewForFocus("branches")
      this.root.requestRender()
      return
    }
    if (this.focusManager.active === "commits") {
      this.commitsPanel = cyclePanelTab(this.commitsPanel, direction)
      this.renderCommitsPane()
      // Activating a context renders it to main (pkg/gui/context.go `Activate` -> HandleFocus).
      this.syncPreviewForFocus("commits")
      this.root.requestRender()
    }
  }
  private actionBranchCheckout(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) {
      const state = panel.child.view
      const id = state.selectedId
      if (id !== undefined && id.startsWith("remote-branch:") && this.onCheckoutRemoteTracking !== undefined) {
        const ref = id.slice("remote-branch:".length)
        if (panel.child.value.kind !== "remote-branches") return
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
      // refs_helper.go:73 attributes a checkout to the branch being checked out.
      this.runUiMutation(() => this.onSwitchLocalBranch!(name), { rowId: id, operation: "checking-out" })
    }
  }

  private actionBranchCreate(): void {
    if (this.mutationInFlight || this.onCreateBranch === undefined) return
    const panel = this.branchesPanel
    let startPoint: string | undefined
    let suggestedBranchName = ""
    let branchBase = ""
    if (panel.child?.value.kind === "remote-branches") {
      const id = panel.child.view.selectedId
      if (id === undefined || !id.startsWith("remote-branch:")) return
      const ref = id.slice("remote-branch:".length)
      const prefix = `${panel.child.value.remote}/`
      if (!ref.startsWith(prefix)) return
      startPoint = ref
      branchBase = ref
      suggestedBranchName = ref.slice(prefix.length)
    } else if (panel.child !== undefined || panel.activeTab !== "branches") {
      return
    } else {
      const id = panel.views.branches?.selectedId
      if (id === undefined || !id.startsWith("local:")) return
      const name = id.slice("local:".length)
      if (!this.model.branches?.localBranches.some((branch) => branch.name === name)) return
      startPoint = `refs/heads/${name}`
      branchBase = name
    }
    this.branchDialogContext = { mode: "branch-create", startPoint, suggestedBranchName, branchBase }
    this.openBranchDialog("branch-create", suggestedBranchName, branchBase)
  }
  private actionBranchDelete(): void {
    if (this.mutationInFlight || this.onDeleteBranch === undefined) return
    const panel = this.branchesPanel
    if (panel.child?.value.kind === "remote-branches") {
      const id = panel.child.view.selectedId
      if (id === undefined || !id.startsWith("remote-branch:")) return
      const ref = id.slice("remote-branch:".length)
      const prefix = `${panel.child.value.remote}/`
      if (!ref.startsWith(prefix)) return
      const remoteBranch = ref.slice(prefix.length)
      this.openBranchDeleteConfirmation(
        { mode: "remote", branch: remoteBranch, remote: panel.child.value.remote, remoteBranch, force: false },
        branchRemoteDeleteConfirmation(remoteBranch, panel.child.value.remote),
      )
      return
    }
    if (panel.child !== undefined || panel.activeTab !== "branches") return
    const id = panel.views.branches?.selectedId
    if (id === undefined || !id.startsWith("local:")) return
    const name = id.slice("local:".length)
    const branch = this.model.branches?.localBranches.find((candidate) => candidate.name === name)
    if (branch === undefined) return
    const upstream = liveBranchUpstream(branch)
    const checkedOutReason = branch.isCurrent ? "You cannot delete the checked out branch!" : undefined
    const upstreamReason = upstream === undefined ? "The selected branch has no upstream (or the upstream is not stored locally)" : undefined
    const localRequest: BranchDeleteRequest = { mode: "local", branch: name, force: false }
    const remoteRequest: BranchDeleteRequest = {
      mode: "remote",
      branch: upstream?.branch ?? name,
      ...(upstream === undefined ? {} : { remote: upstream.remote, remoteBranch: upstream.branch }),
      force: false,
    }
    const bothRequest: BranchDeleteRequest = {
      mode: "local-and-remote",
      branch: name,
      ...(upstream === undefined ? {} : { remote: upstream.remote, remoteBranch: upstream.branch }),
      force: false,
    }
    this.actionMenu.openMenu(`Delete branch '${name}'?`, [
      {
        key: "c",
        label: "Delete local branch",
        onPress: () => this.beginBranchDelete(branch, localRequest),
        ...(checkedOutReason === undefined ? {} : { disabledReason: checkedOutReason }),
      },
      {
        key: "r",
        label: "Delete remote branch",
        onPress: () => this.beginBranchDelete(branch, remoteRequest),
        ...(upstreamReason === undefined ? {} : { disabledReason: upstreamReason }),
      },
      {
        key: "b",
        label: "Delete local and remote branch",
        onPress: () => this.beginBranchDelete(branch, bothRequest),
        ...(checkedOutReason !== undefined ? { disabledReason: checkedOutReason } : upstreamReason === undefined ? {} : { disabledReason: upstreamReason }),
      },
    ])
    this.recomputeLayout()
  }
  private openConfirmation(confirmation: ConfirmationRequest, onConfirm: () => void): void {
    this.panes.main.box.bottomTitle = undefined
    this.actionMenu.openMenu(
      confirmation.title,
      [{
        key: confirmation.confirmKey,
        label: confirmation.confirmLabel,
        onPress: onConfirm,
      }],
      confirmation.message,
    )
    this.recomputeLayout()
  }

  private openBranchDeleteConfirmation(request: BranchDeleteRequest, confirmation: ConfirmationRequest): void {
    this.openConfirmation(confirmation, () => this.runUiMutation(() => this.onDeleteBranch?.(request)))
  }

  private branchActionIsCurrent(generation: number, selectedId: string | undefined): boolean {
    return this.branchActionGeneration === generation &&
      this.focusManager.active === "branches" &&
      this.branchesPanel.child === undefined &&
      this.branchesPanel.activeTab === "branches" &&
      this.branchesPanel.views.branches?.selectedId === selectedId
  }

  private beginBranchDelete(branch: LocalBranch, request: BranchDeleteRequest): void {
    if (request.mode === "remote") {
      if (request.remote === undefined || request.remoteBranch === undefined) return
      this.openBranchDeleteConfirmation(request, branchRemoteDeleteConfirmation(request.remoteBranch, request.remote))
      return
    }
    const worktree = (this.model.worktrees ?? []).find((candidate) => candidate.branch === branch.name && !candidate.isCurrent)
    if (worktree !== undefined) {
      if (this.onDeleteBranchFromWorktree === undefined) {
        this.panes.main.box.bottomTitle = `Branch ${branch.name} is checked out by worktree ${worktree.name}`
        this.root.requestRender()
        return
      }
      this.openWorktreeDeleteMenu(branch, worktree, request)
      return
    }
    const requestGeneration = this.branchActionGeneration
    const requestSelectedId = this.branchesPanel.views.branches?.selectedId
    const checkMerged = this.onCheckBranchMerged
    if (checkMerged === undefined) {
      if (request.mode === "local") {
        this.runUiMutation(() => this.onDeleteBranch?.({ ...request, force: true }))
      } else if (request.remote !== undefined && request.remoteBranch !== undefined) {
        this.openBranchDeleteConfirmation(
          { ...request, force: true },
          branchLocalAndRemoteDeleteConfirmation(branch.name, request.remote, request.remoteBranch, true),
        )
      }
      return
    }
    this.mutationInFlight = true
    this.panes.main.box.bottomTitle = "Checking branch merge state…"
    void checkMerged(branch.name, branch.upstream).then((merged) => {
      this.mutationInFlight = false
      if (!this.branchActionIsCurrent(requestGeneration, requestSelectedId)) {
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return
      }
      if (request.mode === "local" && merged) {
        this.runUiMutation(() => this.onDeleteBranch?.({ ...request, force: true }))
        return
      }
      if (request.mode === "local") {
        this.openBranchDeleteConfirmation({ ...request, force: true }, branchForceDeleteConfirmation(branch.name))
        return
      }
      if (request.remote === undefined || request.remoteBranch === undefined) return
      this.openBranchDeleteConfirmation(
        { ...request, force: true },
        branchLocalAndRemoteDeleteConfirmation(branch.name, request.remote, request.remoteBranch, !merged),
      )
    }).catch((error: unknown) => {
      this.mutationInFlight = false
      if (!this.branchActionIsCurrent(requestGeneration, requestSelectedId)) {
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return
      }
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
  }
  private openWorktreeDeleteMenu(branch: LocalBranch, worktree: Worktree, request: BranchDeleteRequest): void {
    const both = request.mode === "local-and-remote"
    this.actionMenu.openMenu(`Branch ${branch.name} is checked out by worktree ${worktree.name}`, [
      {
        key: "r",
        label: both ? "Remove worktree and delete local and remote branch" : "Remove worktree and delete branch",
        onPress: () => this.confirmWorktreeBranchDelete(branch, worktree, request, "remove"),
      },
      {
        key: "d",
        label: both ? "Detach worktree and delete local and remote branch" : "Detach worktree and delete branch",
        onPress: () => this.confirmWorktreeBranchDelete(branch, worktree, request, "detach"),
      },
    ])
    this.recomputeLayout()
  }

  private runWorktreeBranchDelete(
    worktree: Worktree,
    action: "remove" | "detach",
    request: BranchDeleteRequest,
    forceWorktree: boolean,
  ): void {
    const operation = this.onDeleteBranchFromWorktree
    if (operation === undefined || this.mutationInFlight) return
    this.mutationInFlight = true
    this.clearTransientMenus()
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    void operation(worktree.path, action, { ...request, force: true }, forceWorktree).then(() => {
      this.mutationInFlight = false
      this.onMutationSettled?.()
    }).catch((error: unknown) => {
      this.mutationInFlight = false
      this.onMutationSettled?.()
      if (action === "remove" && !forceWorktree && worktreeRemovalRequiresForce(error)) {
        this.openConfirmation(worktreeForceRemoveConfirmation(worktree.name), () =>
          this.runWorktreeBranchDelete(worktree, action, request, true))
        return
      }
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
  }

  private confirmWorktreeBranchDelete(
    branch: LocalBranch,
    worktree: Worktree,
    request: BranchDeleteRequest,
    action: "remove" | "detach",
  ): void {
    const execute = (): void => {
      this.runWorktreeBranchDelete(worktree, action, request, false)
    }
    const requestGeneration = this.branchActionGeneration
    const requestSelectedId = this.branchesPanel.views.branches?.selectedId
    const checkMerged = this.onCheckBranchMerged
    if (checkMerged === undefined) {
      execute()
      return
    }
    this.mutationInFlight = true
    this.panes.main.box.bottomTitle = "Checking branch merge state…"
    void checkMerged(branch.name, branch.upstream).then((merged) => {
      this.mutationInFlight = false
      if (!this.branchActionIsCurrent(requestGeneration, requestSelectedId)) {
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return
      }
      if (merged) {
        execute()
        return
      }
      this.openConfirmation(branchForceDeleteConfirmation(branch.name), execute)
    }).catch((error: unknown) => {
      this.mutationInFlight = false
      if (!this.branchActionIsCurrent(requestGeneration, requestSelectedId)) {
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return
      }
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
  }


  private actionBranchRename(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) return
    if (panel.activeTab !== "branches") return
    const id = panel.views.branches?.selectedId
    if (id === undefined || !id.startsWith("local:") || this.onRenameBranch === undefined) return
    const name = id.slice("local:".length)
    const branch = this.model.branches?.localBranches.find((candidate) => candidate.name === name)
    if (branch === undefined) return
    const openPrompt = (): void => {
      this.branchDialogContext = { mode: "branch-rename", branch: name }
      this.openBranchDialog("branch-rename", "")
    }
    if (liveBranchUpstream(branch) === undefined) {
      openPrompt()
      return
    }
    this.openConfirmation(branchRenameConfirmation(), openPrompt)
  }

  private actionFetchRemote(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) return
    if (panel.activeTab !== "remotes") return
    const id = panel.views.remotes?.selectedId
    if (id === undefined || !id.startsWith("remote:") || this.onFetchRemote === undefined) return
    const name = id.slice("remote:".length)
    // remotes_controller.go:365 attributes a remote fetch to the remote's own row.
    this.runUiMutation(() => this.onFetchRemote!(name), { rowId: id, operation: "fetching" })
  }

  private requestLocalBranchCommits(branch: string, entering: boolean): void {
    if (this.loadBranchCommits === undefined) return
    const expectedId = `local:${branch}`
    const request = ++this.branchCommitsRequest
    const isCurrent = (): boolean => {
      if (request !== this.branchCommitsRequest) return false
      const child = this.branchesPanel.child
      if (entering) {
        return this.focusManager.active === "branches" &&
          child === undefined &&
          this.branchesPanel.activeTab === "branches" &&
          this.branchesPanel.views.branches?.selectedId === expectedId
      }
      return child?.parentTab === "branches" && child.value.kind === "local-commits" && child.value.branch === branch
    }
    const load = this.loadBranchCommits(branch)
    const requestPromise = load
      .then(async (commits) => {
        if (!isCurrent()) return
        const rows = buildCommitRows(commits, new Date())
        const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No commits" }] : undefined
        if (entering) {
          this.branchesPanel = enterPanelChild(this.branchesPanel, { kind: "local-commits", branch }, createListState(rows, displayRows))
        } else {
          const child = this.branchesPanel.child
          if (child === undefined || child.value.kind !== "local-commits") return
          const view = setListRows(child.view, rows, displayRows)
          this.branchesPanel = { ...this.branchesPanel, child: { ...child, view } }
        }
        this.renderBranchesPane()
        let preview: Promise<void> | undefined
        const previewFocus = this.focusManager.active === "main" ? this.focusManager.lastSide : this.focusManager.active
        if (previewFocus === "branches") {
          this.syncPreviewForFocus("branches")
          preview = this.previewInflight
        }
        this.root.requestRender()
        if (preview !== undefined) await preview
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
        this.root.requestRender()
      })
    this.branchCommitsInflight = requestPromise
  }

  private actionBranchInspect(): void {
    if (this.mutationInFlight) return
    const panel = this.branchesPanel
    if (panel.child !== undefined) {
      const state = panel.child.view
      const id = state.selectedId
      if (id !== undefined && id.startsWith("remote-branch:")) {
        const ref = id.slice("remote-branch:".length)
        if (panel.child.value.kind !== "remote-branches") return
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
      const branch = id.slice("local:".length)
      this.invalidateRemoteCheckout()
      this.panes.branches.box.bottomTitle = undefined
      this.requestLocalBranchCommits(branch, true)
    } else if (id.startsWith("remote:")) {
      const remote = id.slice("remote:".length)
      const rows = remoteBranchRows(this.model, remote, this.branchFilter)
      const childView = createListState(rows)
      this.branchesPanel = enterPanelChild(this.branchesPanel, { kind: "remote-branches", remote }, childView)
      this.renderBranchesPane()
      // Pushing the child context activates it, and activation renders to main
      // (pkg/gui/context.go `Activate` -> HandleFocus).
      this.syncPreviewForFocus("branches")
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
    // Only the Commits tab drills into commit files: lazygit attaches
    // `SwitchToDiffFilesController` to LocalCommits/SubCommits/Stash, never to the reflog
    // context (pkg/gui/controllers.go:240-249).
    if (this.commitsPanel.activeTab !== "commits") return
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
    if (this.popFocusedMainView()) return
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

  /**
   * Escape out of the focused main pane, lazygit's `ContextMgr.Pop()` (pkg/gui/context.go:132).
   * Pushing the main context left the side context underneath it on the stack, so popping lands
   * back on the pane the main view was focused from — `FocusManager.lastSide` here. Returns
   * whether it handled the key, so both Escape handlers can defer to it first.
   */
  private popFocusedMainView(): boolean {
    if (this.focusManager.active !== "main") return false
    this.focusManager.focus(this.focusManager.lastSide)
    return true
  }

  private actionBack(): void {
    if (this.popFocusedMainView()) return
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
    if (this.branchesPanel.child !== undefined) {
      this.invalidateBranchCommitsRequest()
      this.branchesPanel = leavePanelChild(this.branchesPanel)
      this.renderBranchesPane()
      this.syncPreviewForFocus("branches")
      this.root.requestRender()
      return
    } else if (this.pendingRemoteMismatch !== undefined || this.branchFilterActive || this.remoteCheckoutInFlight) {
      this.invalidateRemoteCheckout()
      this.branchFilterActive = false
      this.filterInput.clear()
      this.filterInput.close()
      this.branchFilter = ""
      this.refreshBranchesPanel(this.model)
      this.renderBranchesPane()
      this.recomputeLayout()
      return
    }
    // Generic filter: Esc clears the persisted filter for the focused pane even when
    // the filter input is not active (lazygit's SearchHelper.CancelSearchIfSearching).
    const target = this.currentFilterTarget()
    if (target !== undefined) {
      const key = target.key
      const hasFilter = this.filters.has(key) || (target.pane === "branches" && this.branchFilter.length > 0)
      if (hasFilter) {
        if (target.pane === "branches") {
          this.branchFilter = ""
          this.branchFilterActive = false
          this.filterInput.clear()
          this.filterInput.close()
          this.refreshBranchesPanel(this.model)
          this.renderBranchesPane()
          this.recomputeLayout()
        } else {
          this.filters.delete(key)
          this.filterInput.clear()
          this.filterInput.close()
          this.activeFilterKey = undefined
          this.refreshForFilterKey(key)
          this.renderForFilterKey(key)
          this.recomputeLayout()
        }
        return
      }
    }
  }

  private actionStashCreate(): void {
    if (this.mutationInFlight || this.onCreateStash === undefined) return
    this.stashIncludeUntracked = false
    this.openCommitDialog("")
  }

  private actionStashApply(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntryFromState(this.stashState, this.model)
    if (selected === undefined || this.onApplyStash === undefined) return
    this.openConfirmation(stashApplyConfirmation(selected.ref), () => this.runUiMutation(() => this.onApplyStash?.(selected.oid)))
  }

  private actionStashPop(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntryFromState(this.stashState, this.model)
    if (selected === undefined || this.onPopStash === undefined) return
    this.openConfirmation(stashPopConfirmation(selected.ref), () => this.runUiMutation(() => this.onPopStash?.(selected.oid)))
  }

  private actionStashDrop(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntryFromState(this.stashState, this.model)
    if (selected === undefined || this.onDropStash === undefined) return
    this.openConfirmation(stashDropConfirmation(selected.ref), () => this.runUiMutation(() => this.onDropStash?.(selected.oid)))
  }

  private actionStashInspect(): void {
    if (this.mutationInFlight) return
    const selected = selectedStashEntryFromState(this.stashState, this.model)
    if (selected === undefined || this.onInspectStash === undefined) return
    this.runUiMutation(() => this.onInspectStash!(selected.oid))
  }

  private actionCommit(): void {
    if (this.mutationInFlight || this.onCommitMessage === undefined) return
    if (!this.commitAttemptAvailable()) return
    this.withEnsureCommittableFiles(() => this.openCommitMessagePanel("commit", ""))
  }

  private actionAmend(): void {
    if (this.mutationInFlight || this.onAmendMessage === undefined || this.onCurrentCommitMessage === undefined) return
    if (!this.commitAttemptAvailable()) return
    this.withEnsureCommittableFiles(() => this.openAmendDialog())
  }

  /**
   * Committing targets the index, which only exists for a working-tree review; branch, commit
   * and stash reviews are read-only (AppController.ensureWorkingTreeMutation refuses the same set).
   */
  private commitAttemptAvailable(): boolean {
    if (this.model.reviewTarget.kind !== "working-tree") {
      this.panes.main.box.bottomTitle = this.model.reviewTarget.kind === "stash" ? "Stash Review is read-only" : "Commit drill-down is read-only"
      return false
    }
    const active = this.focusManager.active
    if (active !== "files" && active !== "main") {
      this.panes.main.box.bottomTitle = "Commit is available in Files or Main"
      return false
    }
    return true
  }

  /**
   * lazygit's WithEnsureCommittableFiles commits whatever the index holds and, when nothing is
   * staged, prompts to stage everything before retrying the handler
   * (pkg/gui/controllers/helpers/working_tree_helper.go:229-258). Githunk's confirmation idiom
   * is a second press of the same key, as with file discard and stash drop.
   */
  private withEnsureCommittableFiles(retry: () => void | Promise<void>): void {
    if (anyStagedChanges(this.model)) {
      this.pendingStageAllCommit = false
      void retry()
      return
    }
    if (this.model.files.length === 0) {
      this.panes.main.box.bottomTitle = "No changes to commit"
      return
    }
    if (!this.pendingStageAllCommit) {
      this.pendingStageAllCommit = true
      this.panes.main.box.bottomTitle = "Nothing staged — press the same key again to stage everything"
      this.root.requestRender()
      return
    }
    this.pendingStageAllCommit = false
    if (this.onToggleAllFiles === undefined) return
    this.runUiMutation(async () => {
      await this.onToggleAllFiles!()
      await retry()
    })
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
    this.runUiMutation(() => this.onScopeChange!(SCOPE_ORDER[nextIndex]!))
  }

  private actionFetch(): void {
    if (this.mutationInFlight || this.onFetch === undefined) return
    this.runUiMutation(() => this.onFetch!())
  }

  /**
   * sync_controller.go:161,196 attributes a pull or a push to the *current* branch's row, whichever
   * panel the key was pressed in.
   */
  private currentBranchRowId(): string | undefined {
    const current = this.model.branches?.localBranches.find((branch) => branch.isCurrent)?.name
    return current === undefined ? undefined : `local:${current}`
  }

  private actionPull(): void {
    if (this.mutationInFlight || this.onPull === undefined) return
    const rowId = this.currentBranchRowId()
    this.runUiMutation(() => this.onPull!(), rowId === undefined ? undefined : { rowId, operation: "pulling" })
  }

  private actionPush(): void {
    if (this.mutationInFlight || this.onPush === undefined) return
    const rowId = this.currentBranchRowId()
    this.runUiMutation(() => this.onPush!(), rowId === undefined ? undefined : { rowId, operation: "pushing" })
  }

  private actionRefresh(): void {
    if (this.onRefresh === undefined) return
    this.invalidateRemoteCheckout()
    this.panes.branches.box.bottomTitle = undefined
    this.runUiMutation(() => this.onRefresh!())
  }

  private actionOpenBranchReview(): void {
    if (this.mutationInFlight || this.onOpenBranchReview === undefined) return
    this.runUiMutation(() => this.onOpenBranchReview!())
  }

  private actionFilter(): void {
    const target = this.currentFilterTarget()
    if (target === undefined) return
    if (target.pane === "branches" && target.child === undefined) {
      this.branchActionGeneration += 1
      this.invalidateRemoteCheckout()
      this.filterInput.open()
      this.branchFilterActive = true
      this.branchFilter = ""
      this.refreshBranchesPanel(this.model)
      this.renderBranchesPane()
      this.recomputeLayout()
      return
    }
    // Generic filter for files, commits, stash, main, and branches children
    // (lazygit's per-context filter: pkg/gui/context/filtered_list_view_model.go:27,
    // pkg/gui/controllers/helpers/search_helper.go:32-48).
    this.activeFilterKey = target.key
    const existing = this.getFilterForKey(target.key)
    if (existing.length > 0) this.filters.delete(target.key)
    this.filterInput.open("")
    this.refreshForFilterKey(target.key)
    this.renderForFilterKey(target.key)
    this.recomputeLayout()
  }

  private actionSearchNext(): void {
    const focus = this.focusManager.active
    if (focus === "commits") {
      const query = this.getFilterForKey(this.filterKey("commits", "commits"))
      if (query.length === 0) return
      const view = this.commitsView()
      if (!view || view.rows.length === 0) return
      const normalizedQuery = query.toLowerCase()
      const current = view.selectedIndex
      let next = -1
      for (let i = current + 1; i < view.rows.length; i++) {
        const row = view.rows[i]!
        const text = `${row.columns[0]?.text ?? ""} ${row.columns[3]?.text ?? ""}`.toLowerCase()
        if (text.includes(normalizedQuery)) { next = i; break }
      }
      if (next === -1) {
        for (let i = 0; i <= current; i++) {
          const row = view.rows[i]!
          const text = `${row.columns[0]?.text ?? ""} ${row.columns[3]?.text ?? ""}`.toLowerCase()
          if (text.includes(normalizedQuery)) { next = i; break }
        }
      }
      if (next !== -1 && next !== current) {
        const panel = this.commitsPanel
        const targetTab = panel.activeTab
        const currentView = panel.views[targetTab]
        if (currentView) {
          const nextState = selectListRow(currentView, view.rows[next]!.id)
          this.commitsPanel = updatePanelView(panel, targetTab, nextState)
          this.renderCommitsPane()
          this.revealListRow("commits", this.panes.commits, next)
          this.syncPreviewForFocus("commits")
          this.root.requestRender()
        }
      }
      return
    }
    if (focus === "main") {
      const query = this.getFilterForKey(this.filterKey("main"))
      if (query.length === 0) return
      const text = getMainRenderedText(this.panes.main) ?? getMainDocument(this.panes.main)?.text ?? ""
      if (text.length === 0) return
      const normalizedText = text.toLowerCase()
      const normalizedQuery = query.toLowerCase()
      const currentY = this.panes.main.text.scrollY
      const lines = text.split("\n")
      let currentLine = currentY
      // Find next line containing query after currentLine
      let nextLine = -1
      for (let i = currentLine + 1; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(normalizedQuery)) { nextLine = i; break }
      }
      if (nextLine === -1) {
        for (let i = 0; i <= currentLine; i++) {
          if (lines[i]!.toLowerCase().includes(normalizedQuery)) { nextLine = i; break }
        }
      }
      if (nextLine !== -1) {
        this.clearNonStickyMainRange()
        const targetY = Math.max(0, nextLine - 2)
        this.panes.main.text.scrollY = targetY
        this.panes.main.box.bottomTitle = `Search: ${query} (${nextLine + 1}/${lines.length})`
        this.root.requestRender()
      }
      return
    }
  }

  private actionSearchPrevious(): void {
    const focus = this.focusManager.active
    if (focus === "commits") {
      const query = this.getFilterForKey(this.filterKey("commits", "commits"))
      if (query.length === 0) return
      const view = this.commitsView()
      if (!view || view.rows.length === 0) return
      const normalizedQuery = query.toLowerCase()
      const current = view.selectedIndex
      let prev = -1
      for (let i = current - 1; i >= 0; i--) {
        const row = view.rows[i]!
        const text = `${row.columns[0]?.text ?? ""} ${row.columns[3]?.text ?? ""}`.toLowerCase()
        if (text.includes(normalizedQuery)) { prev = i; break }
      }
      if (prev === -1) {
        for (let i = view.rows.length - 1; i >= current; i--) {
          const row = view.rows[i]!
          const text = `${row.columns[0]?.text ?? ""} ${row.columns[3]?.text ?? ""}`.toLowerCase()
          if (text.includes(normalizedQuery)) { prev = i; break }
        }
      }
      if (prev !== -1 && prev !== current) {
        const panel = this.commitsPanel
        const targetTab = panel.activeTab
        const currentView = panel.views[targetTab]
        if (currentView) {
          const prevState = selectListRow(currentView, view.rows[prev]!.id)
          this.commitsPanel = updatePanelView(panel, targetTab, prevState)
          this.renderCommitsPane()
          this.revealListRow("commits", this.panes.commits, prev)
          this.syncPreviewForFocus("commits")
          this.root.requestRender()
        }
      }
      return
    }
    if (focus === "main") {
      const query = this.getFilterForKey(this.filterKey("main"))
      if (query.length === 0) return
      const text = getMainRenderedText(this.panes.main) ?? getMainDocument(this.panes.main)?.text ?? ""
      if (text.length === 0) return
      const lines = text.split("\n")
      const currentY = this.panes.main.text.scrollY
      const normalizedQuery = query.toLowerCase()
      let prevLine = -1
      for (let i = currentY - 1; i >= 0; i--) {
        if (lines[i]!.toLowerCase().includes(normalizedQuery)) { prevLine = i; break }
      }
      if (prevLine === -1) {
        for (let i = lines.length - 1; i >= currentY; i--) {
          if (lines[i]!.toLowerCase().includes(normalizedQuery)) { prevLine = i; break }
        }
      }
      if (prevLine !== -1) {
        this.clearNonStickyMainRange()
        const targetY = Math.max(0, prevLine - 2)
        this.panes.main.text.scrollY = targetY
        this.panes.main.box.bottomTitle = `Search: ${query} (${prevLine + 1}/${lines.length})`
        this.root.requestRender()
      }
      return
    }
  }

  private actionCopyMenu(): void {
    this.copyMenuOpen = true
    const items = COPY_MENU_ITEMS.map((item, index) => ({
      key: String(index + 1),
      label: item.label,
      onPress: () => {
        this.copyMenuOpen = false
        this.copyMainMode(item.mode)
      },
    }))
    this.actionMenu.openMenu("Copy", items, "Choose a copy mode (1-9, j/k, Enter) — Esc to close")
    this.recomputeLayout()
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

  private mainActionTarget(document: DiffDocument): MainCursorTarget | undefined {
    const selected = getMainDiffLineSelection(this.panes.main)
    const firstIndex = selected?.indexes[0]
    const line = firstIndex === undefined ? undefined : document.lines[firstIndex]
    if (line !== undefined) {
      return {
        fileIndex: line.fileIndex,
        ...(line.hunkIndex === undefined ? {} : { hunkIndex: line.hunkIndex }),
      }
    }
    return getMainCursorTarget(this.panes.main)
  }

  private mainChangeSelection(): { readonly document: DiffDocument; readonly indexes: readonly number[] } | undefined {
    const document = getMainDocument(this.panes.main)
    if (!document) return undefined
    const keyboardSelection = getMainDiffLineSelection(this.panes.main)
    if (keyboardSelection !== undefined) {
      return {
        document,
        indexes: changeLineIndexes(document, keyboardSelection.startUtf16, keyboardSelection.endUtf16),
      }
    }
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
      this.promptPopup.close()
      this.clearTransientMenus()
      this.recomputeLayout()
      this.root.requestRender()
      return true
    }
    if (result.result?.kind === "confirmed") {
      const message = result.result.message
      let branchName: string | undefined
      let operation: (() => Promise<void>) | undefined
      let autostashOperation: (() => Promise<void>) | undefined
      if (context.mode === "branch-create") {
        if (this.onCreateBranch === undefined) return true
        branchName = sanitizeBranchName(message)
        const options = { track: context.suggestedBranchName.length > 0 && branchName === context.suggestedBranchName }
        operation = () => this.onCreateBranch!(context.startPoint, branchName, options)
        if (this.onCreateBranchWithAutostash !== undefined) {
          autostashOperation = () => this.onCreateBranchWithAutostash!(context.startPoint, branchName, options)
        }
      } else if (this.onRenameBranch !== undefined) {
        operation = () => this.onRenameBranch!(context.branch, message)
      }
      if (operation === undefined) return true
      const isBranchCreate = context.mode === "branch-create"
      this.commitDialog = undefined
      this.branchDialogContext = undefined
      this.promptPopup.close()
      this.recomputeLayout()
      if (isBranchCreate) this.runBranchCreate(operation, autostashOperation, branchName ?? "")
      else this.runUiMutation(operation)
      return true
    }
    const next = result
    const nextDialog = new CommitDialog(next.state.mode, next.state.message, context.mode === "branch-create" ? context.branchBase : undefined)
    nextDialog.setError(next.state.error)
    this.commitDialog = nextDialog
    this.promptPopup.update(nextDialog.state)
    this.recomputeLayout()
    this.root.requestRender()
    return true
  }

  private handleStashDialogKey(key: KeyEvent): boolean {
    const dialog = this.commitDialog
    if (dialog === undefined || dialog.state.mode !== "stash") return false
    const result = commitDialogKey(dialog.state, key)
    if (result.result?.kind === "cancelled") {
      this.commitDialog = undefined
      this.promptPopup.close()
      this.recomputeLayout()
      this.root.requestRender()
      return true
    }
    if (result.result?.kind === "confirmed") {
      if (this.onCreateStash === undefined) return true
      this.mutationInFlight = true
      void this.onCreateStash(result.result.message, this.stashIncludeUntracked).then(() => {
        if (this.commitDialog === dialog) {
          this.commitDialog = undefined
          this.promptPopup.close()
          this.recomputeLayout()
        }
      }).catch((error: unknown) => {
        dialog.setError(error instanceof Error ? error.message : String(error))
        this.promptPopup.update(dialog.state, `Include untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`)
        this.recomputeLayout()
      }).finally(() => {
        this.mutationInFlight = false
        this.root.requestRender()
      })
      return true
    }
    const next = commitDialogKey(dialog.state, key)
    this.commitDialog = new CommitDialog("stash", next.state.message)
    this.commitDialog.setError(next.state.error)
    this.promptPopup.update(this.commitDialog.state, `Include untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`)
    this.recomputeLayout()
    this.root.requestRender()
    return true
  }

  private invalidateRemoteCheckout(): void {
    this.remoteCheckoutGeneration += 1
    this.pendingRemoteMismatch = undefined
    if (this.actionMenu.isOpen() && this.actionMenu.box.title === "Remote tracking mismatch") {
      this.actionMenu.close()
      this.recomputeLayout()
    }
  }
  private invalidateBranchCommitsRequest(): void {
    this.branchCommitsRequest += 1
  }

  private runRemoteCheckout(selection: RemoteBranchSelection, confirmedMismatch: boolean): void {
    if (this.onCheckoutRemoteTracking === undefined || this.mutationInFlight) return
    const requestGeneration = ++this.remoteCheckoutGeneration
    const requestFocus = this.focusManager.active
    const requestActiveTab = this.branchesPanel.activeTab
    const requestChild = this.branchesPanel.child
    const requestChildRemote = requestChild?.value.kind === "remote-branches" ? requestChild.value.remote : null
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
        requestChildRemote !== (requestChild?.value.kind === "remote-branches" ? requestChild.value.remote : null) ||
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
        this.actionMenu.openMenu(
          confirmation.title,
          [{ key: confirmation.confirmKey, label: confirmation.confirmLabel, onPress: () => this.actionBranchInspect() }],
          confirmation.message,
        )
        this.recomputeLayout()
      } else {
        this.pendingRemoteMismatch = undefined
        if (this.actionMenu.isOpen() && this.actionMenu.box.title === "Remote tracking mismatch") {
          this.actionMenu.close()
        }
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
        this.clearTransientMenus()
      }
    })
  }
  private openCommitDialog(initialMessage: string): void {
    this.commitDialog = new CommitDialog("stash", initialMessage)
    this.promptPopup.open(this.commitDialog.state, `Include untracked: ${this.stashIncludeUntracked ? "yes" : "no"} (Ctrl+u toggles)`)
    this.recomputeLayout()
    this.root.requestRender()
  }

  private openCommitMessagePanel(mode: "commit" | "amend", initialMessage: string): void {
    this.commitMessagePanel.open(mode, initialMessage)
    this.recomputeLayout()
    this.root.requestRender()
  }

  private openBranchDialog(mode: "branch-create" | "branch-rename", initialMessage: string, branchBase?: string): void {
    this.commitDialog = new CommitDialog(mode, initialMessage, branchBase)
    this.promptPopup.open(this.commitDialog.state)
    this.recomputeLayout()
    this.root.requestRender()
  }

  private async openAmendDialog(): Promise<void> {
    if (this.onCurrentCommitMessage === undefined) return
    const ownsMutation = !this.mutationInFlight
    if (ownsMutation) this.mutationInFlight = true
    try {
      const message = await this.onCurrentCommitMessage()
      this.openCommitMessagePanel("amend", message)
    } catch (error: unknown) {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    } finally {
      if (ownsMutation) this.mutationInFlight = false
    }
  }

  private handleCommitMessagePanelKey(key: KeyEvent): void {
    const result = this.commitMessagePanel.handleKey(key)
    if (result === undefined) {
      this.root.requestRender()
      return
    }
    if (result.kind === "changed") {
      this.recomputeLayout()
      return
    }
    if (result.kind === "cancelled") {
      this.commitMessagePanel.close()
      this.recomputeLayout()
      this.root.requestRender()
      return
    }

    const operation = this.commitMessagePanel.mode === "amend" ? this.onAmendMessage : this.onCommitMessage
    if (operation === undefined) {
      this.commitMessagePanel.setError("Commit operation is unavailable")
      this.root.requestRender()
      return
    }
    this.mutationInFlight = true
    void operation(result.message).then(() => {
      this.commitMessagePanel.close()
      this.recomputeLayout()
    }).catch((error: unknown) => {
      this.commitMessagePanel.setError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      this.mutationInFlight = false
      this.root.requestRender()
    })
  }

  /** The clock and per-row extras every branches-panel row build needs. */
  private branchRowOptions(): BranchRowOptions {
    return {
      ...(this.itemOperations.size === 0 ? {} : { itemOperations: this.itemOperations }),
      ...(this.model.pullRequests === undefined ? {} : { pullRequests: this.model.pullRequests }),
    }
  }

  /** The operation showing on a row, if any. Test and diagnostics accessor. */
  itemOperationFor(rowId: string): ItemOperation | undefined {
    return this.itemOperations.get(rowId)
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return
    this.spinnerTimer = setInterval(() => {
      this.refreshBranchesPanel(this.model)
      this.renderBranchesPane()
      this.root.requestRender()
    }, SPINNER_RATE_MS)
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = undefined
  }

  private beginItemOperation(rowId: string, operation: ItemOperation): void {
    this.itemOperations.set(rowId, operation)
    this.startSpinner()
    this.refreshBranchesPanel(this.model)
    this.renderBranchesPane()
    this.root.requestRender()
  }

  private endItemOperation(rowId: string): void {
    if (!this.itemOperations.delete(rowId)) return
    if (this.itemOperations.size === 0) this.stopSpinner()
    this.refreshBranchesPanel(this.model)
    this.renderBranchesPane()
    this.root.requestRender()
  }

  private runBranchCreate(
    operation: () => Promise<void>,
    autostashOperation: (() => Promise<void>) | undefined,
    branchName: string,
    finishOnFailure = false,
  ): void {
    if (this.mutationInFlight) return
    this.mutationInFlight = true
    this.clearTransientMenus()
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    void operation().then(() => {
      this.mutationInFlight = false
      this.finishBranchCreate(branchName)
      this.onMutationSettled?.()
    }).catch((error: unknown) => {
      this.mutationInFlight = false
      this.onMutationSettled?.()
      if (autostashOperation !== undefined && branchCheckoutRequiresStash(error)) {
        this.openConfirmation(branchAutostashConfirmation(), () => this.runBranchCreate(autostashOperation, undefined, branchName, true))
        return
      }
      if (finishOnFailure) {
        this.finishBranchCreate(branchName)
      }
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
  }

  private finishBranchCreate(branchName: string): void {
    if (this.branchesPanel.child !== undefined) {
      this.branchesPanel = { ...leavePanelChild(this.branchesPanel), activeTab: "branches" }
    }
    const localId = `local:${branchName}`
    const branchView = this.branchesPanel.views.branches
    if (branchView.rows.some((row) => row.id === localId)) {
      this.branchesPanel = {
        ...this.branchesPanel,
        views: { ...this.branchesPanel.views, branches: selectListRow(branchView, localId) },
      }
    }
    if (this.focusManager.active !== "branches") this.focusManager.focus("branches")
    this.renderBranchesPane()
    this.syncPreviewForFocus("branches")
    this.root.requestRender()
  }


  /**
   * `inlineStatus` attributes the operation to one list row for its duration, which is lazygit's
   * `WithInlineStatus` (inline_status_helper.go:65-95): the row itself says `Pulling ●∙∙` instead of
   * showing ahead/behind counts that the operation is in the middle of invalidating.
   */
  private runUiMutation(
    operation: () => Promise<void> | undefined,
    inlineStatus?: { readonly rowId: string; readonly operation: ItemOperation },
  ): void {
    if (this.mutationInFlight) return
    this.mutationInFlight = true
    this.clearTransientMenus()
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    if (inlineStatus !== undefined) this.beginItemOperation(inlineStatus.rowId, inlineStatus.operation)
    const promise = operation()
    if (promise === undefined) {
      this.mutationInFlight = false
      if (inlineStatus !== undefined) this.endItemOperation(inlineStatus.rowId)
      return
    }
    void promise.catch((error: unknown) => {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    }).finally(() => {
      this.mutationInFlight = false
      this.clearTransientMenus()
      if (inlineStatus !== undefined) this.endItemOperation(inlineStatus.rowId)
      this.onMutationSettled?.()
    })
  }

  /** Resolves when the current Main preview or panel-3 branch-history load has settled. */
  whenPreviewSettled(): Promise<void> {
    return Promise.all([this.previewInflight, this.branchCommitsInflight]).then(() => {})
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
    this.installedMainTooSmall = this.geometry.tooSmall
    installMainPaneContent(this.panes.main, content, this.geometry.tooSmall)
    this.root.requestRender()
  }

  private refreshCommitsPanel(model: AppModel): void {
    const commits = model.commits ?? []
    // Commits tab is searchable per lazygit (LocalCommitsContext is ISearchable, not filterable).
    // We keep the full list and highlight matches via bottomTitle and selection, rather than
    // filtering the rows (which would be `IFilterableContext` semantics).
    const commitsSearch = this.getFilterForKey(this.filterKey("commits", "commits"))
    const rows = buildCommitRows(commits, new Date())
    const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: model.loading ? "Loading…" : "No commits" }] : undefined
    const reflogFilter = this.getFilterForKey(this.filterKey("commits", "reflog"))
    const reflog = reflogRows(model, reflogFilter)
    const reflogDisplayRows = reflog.length === 0 ? [{ kind: "message" as const, text: NO_REFLOG_HISTORY }] : undefined
    let panel = this.commitsPanel
    // For searchable commits, preserve the full list; the search query is shown in the
    // pane's bottomTitle via handleGenericFilterKey, and selection jumps to the first match.
    let commitsState = setListRows(panel.views.commits, rows, displayRows)
    if (commitsSearch.length > 0 && rows.length > 0) {
      const normalized = commitsSearch.toLowerCase()
      const matchIndex = rows.findIndex((row) => (row.columns[3]?.text ?? "").toLowerCase().includes(normalized) || (row.columns[0]?.text ?? "").toLowerCase().includes(normalized))
      if (matchIndex >= 0) {
        const matchId = rows[matchIndex]!.id
        commitsState = selectListRow(commitsState, matchId)
      }
    }
    panel = updatePanelView(panel, "commits", commitsState)
    panel = updatePanelView(panel, "reflog", setListRows(panel.views.reflog, reflog, reflogDisplayRows))
    if (panel.child !== undefined) {
      const details = panel.child.value.details
      const commitFilesKey = this.filterKey("commits", "commit-files", details.oid)
      const commitFilesFilter = this.getFilterForKey(commitFilesKey)
      const fileRows = commitFileRows(details, commitFilesFilter)
      const displayRowsChild = fileRows.length === 0 ? [{ kind: "message" as const, text: "No files" }] : undefined
      const listRows = fileRows.length === 0 ? [] : fileRows
      const nextView = setListRows(panel.child.view, listRows, displayRowsChild)
      panel = { ...panel, child: { ...panel.child, view: nextView } }
    }
    this.commitsPanel = panel
  }

  private renderCommitsPane(): void {
    const pane = this.panes.commits
    if (this.commitsPanel.child !== undefined) {
      // lazygit's commit files are their own view with a `DynamicTitleBuilder` and no tabs
      // (pkg/gui/context/commit_files_context.go:48), so the strip is replaced, not extended.
      const short = this.commitsPanel.child.value.details.shortOid ?? this.commitsPanel.child.value.details.oid.slice(0, 8)
      pane.setPlainTitle?.(`[${COMMITS_JUMP_KEY}]${TITLE_PREFIX_FRAME_RUNE}Diff files (${short})`)
    } else {
      const tabsInput = this.commitsTabsInput()
      pane.setTabs?.({ tabs: tabsInput.tabs, activeIndex: tabsInput.activeIndex, focused: tabsInput.focused })
    }
    const activeView = this.activeListView("commits")
    if (activeView === undefined) {
      pane.update("")
      return
    }
    const { state } = activeView
    const width = sidePaneListWidth(this.geometry.windows.commits, state)
    const focused = this.focusManager.active === "commits"
    const content = renderListRows(state, focused, width, this.hoveredIdFor(activeView))
    pane.update(content)
    pane.syncScrollbar(sidePaneViewportHeight(this.geometry.windows.commits))
  }

  private installInitialMainContent(model: AppModel): void {
    const content = this.presentFilesContent(model)
    this.mainGate.installSynchronous(content)
  }

  /**
   * The whole working-tree patch, parsed once per refresh. Focus changes and cursor moves
   * re-present the same patch, so this is keyed on the patch text rather than redone per keypress;
   * parsing is pure and the document is immutable, so sharing it is safe.
   */
  private filesDocument(text: string): DiffDocument | undefined {
    const cached = this.filesDocumentCache
    if (cached !== undefined && cached.text === text) return cached.document
    try {
      const document = parseDiff(text)
      this.filesDocumentCache = { text, document }
      return document
    } catch {
      return undefined
    }
  }

  /**
   * The selected node's own patch, as lazygit's files pane renders it: a file row diffs that file
   * and a directory row diffs its subtree (`pathsForDiff` →
   * `WorktreeFileDiffCmdObj`, pkg/gui/controllers/files_controller.go:373). Sliced out of the
   * already-parsed tree patch instead of re-running git, and re-parsed standalone so line staging
   * and selection see a patch `git apply` accepts.
   */
  private selectedFilesDocument(row: FileTreeRow<ChangedFile> | undefined, text: string, document: DiffDocument): DiffDocument {
    if (row === undefined) return document
    const cached = this.filesSelectionCache
    if (cached !== undefined && cached.text === text && cached.rowId === row.id) return cached.document
    const prefix = row.kind === "directory" ? `${row.path}/` : undefined
    const wanted = (path: string | undefined): boolean =>
      path !== undefined && path !== "/dev/null" && (prefix === undefined ? path === row.path : path.startsWith(prefix))
    let sliced = ""
    for (const file of document.files) {
      if (wanted(file.newPath) || wanted(file.oldPath)) sliced += text.slice(file.startUtf16, file.endUtf16)
    }
    // A one-file patch is its own slice; nothing to gain from parsing it twice. An empty slice
    // means the row named nothing in the patch (a submodule row, say), so keep the whole patch.
    const document_ = sliced.length === 0 || sliced.length === text.length ? document : parseDiff(sliced)
    this.filesSelectionCache = { text, rowId: row.id, document: document_ }
    return document_
  }

  private presentFilesContent(model: AppModel): MainPaneContent {
    const row = this.selectedFileRow()
    const stableId = row?.path ?? "empty"
    const label = row?.path ?? "Files"
    const text = model.rawPatchSections.length > 0 ? model.rawPatchSections.map((p) => p.text).join("") : model.patches.map((p) => p.text).join("")
    if (text.length > 0) {
      const document = this.filesDocument(text)
      if (document !== undefined) return { source: "files", stableId, label, document: this.selectedFilesDocument(row, text, document) }
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
  /**
   * lazygit's `GetGraphCmdObj(ref.FullRefName())` render-to-main: the selected ref's commit graph,
   * coloured by git itself. All three panel-3 tabs and the RemoteBranches drill-down share it,
   * because lazygit shares it too — branches_controller.go:207, remote_branches_controller.go:122
   * and tags_controller.go:109 all call the one command.
   */
  private requestRefLog(source: RefLogTarget["kind"], name: string, label: string, preamble?: string): void {
    const preambleField = preamble === undefined ? {} : { preamble }
    if (this.loadRefLogInspection === undefined) {
      // No git behind the view (unit harnesses): the ref is still named, so the pane says what it
      // is showing rather than going blank.
      this.mainGate.installSynchronous({ source, stableId: name, label, ...preambleField, plainText: `${preamble ?? ""}${name}` })
      return
    }
    const load = (): Promise<string> => this.loadRefLogInspection!({ kind: source, name })
    const present = (raw: string): MainPaneContent => ({ source, stableId: name, label, ...preambleField, ansi: parseAnsi(raw) })
    this.previewInflight = this.mainGate.request(source, name, load, present).catch(() => {})
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
      if (this.commitsPanel.activeTab === "reflog") {
        // reflog_commits_controller.go:40-52 — `git show <hash>` for the selection, or the
        // literal "No reflog history" when there is none. A reflog entry points at a real
        // commit, so this reuses the Commits tab's own commit preview, keyed on that oid.
        const entry = this.selectedReflogEntry()
        if (entry === undefined) {
          this.mainGate.installSynchronous({ source: "reflog", stableId: "reflog-empty", label: "Reflog", plainText: NO_REFLOG_HISTORY })
          return
        }
        if (this.loadCommitInspection !== undefined) {
          const load = (): Promise<CommitDetails> => this.loadCommitInspection!(entry.oid)
          const present = (details: CommitDetails): MainPaneContent => this.presentCommitContent(details)
          const promise = this.mainGate.request("commit", entry.oid, load, present)
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
      const active = this.filesPanel.activeTab
      if (active === "worktrees") {
        // worktrees_controller.go:80-118 GetOnRenderToMain.
        const worktree = selectedWorktreeFrom(this.model, this.filesPanel.views.worktrees?.selectedId)
        this.mainGate.installSynchronous(worktree === undefined
          ? { source: "worktree", stableId: "worktree-empty", label: "Worktree", plainText: NO_WORKTREES_THIS_REPO }
          : { source: "worktree", stableId: worktree.path, label: worktree.name, plainText: worktreePreviewText(worktree) })
        return
      }
      if (active === "submodules") {
        // submodules_controller.go:107-127 GetOnRenderToMain.
        const submodule = selectedSubmoduleFrom(this.model, this.filesPanel.views.submodules?.selectedId)
        this.mainGate.installSynchronous(submodule === undefined
          ? { source: "submodule", stableId: "submodule-empty", label: "Submodule", plainText: NO_SUBMODULES }
          : { source: "submodule", stableId: submoduleFullName(submodule), label: submoduleFullName(submodule), plainText: submodulePreviewText(submodule) })
        return
      }
      this.mainGate.installSynchronous(this.presentFilesContent(this.model))
      return
    }
    if (focus === "branches") {
      const panel = this.branchesPanel
      // Panel 3's transient children mirror lazygit's RemoteBranches and SubCommits contexts:
      // remote branches render a ref graph, while local-branch commits render commit inspection.
      if (panel.child !== undefined) {
        const child = panel.child
        if (child.value.kind === "local-commits") {
          const selectedId = child.view.selectedId
          if (selectedId === undefined) {
            this.mainGate.installSynchronous({ source: "commit", stableId: "local-commits-empty", label: "Commit", plainText: "No commits" })
            return
          }
          if (this.loadCommitInspection === undefined) {
            this.mainGate.installSynchronous({ source: "commit", stableId: selectedId, label: selectedId, plainText: selectedId })
            return
          }
          const load = (): Promise<CommitDetails> => this.loadCommitInspection!(selectedId)
          const present = (details: CommitDetails): MainPaneContent => this.presentCommitContent(details)
          const promise = this.mainGate.request("commit", selectedId, load, present)
          this.previewInflight = promise.catch(() => {})
          return
        }
        const selectedId = child.view.selectedId
        const ref = selectedId !== undefined && selectedId.startsWith("remote-branch:") ? selectedId.slice("remote-branch:".length) : undefined
        if (ref === undefined) {
          this.mainGate.installSynchronous({ source: "remote-branch", stableId: `${child.value.remote}:empty`, label: MAIN_TITLE_REMOTE_BRANCH, plainText: NO_BRANCHES_FOR_REMOTE })
          return
        }
        this.requestRefLog("remote-branch", ref, MAIN_TITLE_REMOTE_BRANCH)
        return
      }
      const active = panel.activeTab
      const selectedId = panel.views[active]?.selectedId
      if (active === "remotes") {
        // remotes_controller.go:101-125: the only panel-3 tab that renders text, not a graph.
        const name = selectedId !== undefined && selectedId.startsWith("remote:") ? selectedId.slice("remote:".length) : undefined
        const remote = name === undefined ? undefined : this.model.branches?.remotes.find((candidate) => candidate.name === name)
        this.mainGate.installSynchronous(remote === undefined
          ? { source: "remote", stableId: "remote-empty", label: MAIN_TITLE_REMOTE, plainText: NO_REMOTES }
          : { source: "remote", stableId: remote.name, label: MAIN_TITLE_REMOTE, plainText: remotePreviewText(remote) })
        return
      }
      if (active === "tags") {
        // tags_controller.go:101-123: the tag's own info, a `---` rule, then the graph.
        const ref = selectedId !== undefined && selectedId.startsWith("tag:") ? selectedId.slice("tag:".length) : undefined
        const tag = ref === undefined ? undefined : this.model.tags?.find((candidate) => candidate.ref === ref)
        if (tag === undefined) {
          this.mainGate.installSynchronous({ source: "tag", stableId: "tag-empty", label: MAIN_TITLE_TAG, plainText: NO_TAGS })
          return
        }
        this.requestRefLog("tag", tag.ref, MAIN_TITLE_TAG, tagPreamble(tag))
        return
      }
      const branch = selectedId !== undefined && selectedId.startsWith("local:") ? selectedId.slice("local:".length) : undefined
      if (branch === undefined) {
        this.mainGate.installSynchronous({ source: "local-branch", stableId: "branch-empty", label: MAIN_TITLE_LOG, plainText: NO_BRANCHES_THIS_REPO })
        return
      }
      this.requestRefLog("local-branch", branch, MAIN_TITLE_LOG)
      return
    }
    if (focus === "stash") {
      const selectedId = this.stashState?.selectedId
      const entry = selectedId !== undefined ? (this.model.stashes ?? []).find((s) => s.oid === selectedId) : undefined
      const stableId = entry?.ref ?? selectedId ?? "stash-empty"
      const content: MainPaneContent = { source: "stash", stableId, label: entry?.ref ?? "Stash", plainText: entry !== undefined ? `${entry.ref} ${entry.message}` : "No stashes" }
      this.mainGate.installSynchronous(content)
      return
    }
    // `main` deliberately renders nothing: lazygit's `Contexts().Normal` is a `MainContext`
    // with no focus-time render-to-main (pkg/gui/context/main_context.go), and
    // `SwitchToFocusedMainViewController` only pushes it (clearing the search string), so
    // focusing the main pane cannot change what the main pane shows. Not touching `mainGate`
    // is also what preserves an in-flight preview: the gate's generation/identity guard only
    // discards a request when a *newer* one supersedes it.
    // Same for status, etc.: keep whatever is installed.
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
    this.clearTransientMenus()
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
    const keyboardSelection = getMainDiffLineSelection(pane)
    const nativeRange = pane.text.getSelection()
    let selection = mode === "hunk" || mode === "file" || keyboardSelection === undefined
      ? undefined
      : {
        valid: true as const,
        startUtf16: keyboardSelection.startUtf16,
        endUtf16: keyboardSelection.endUtf16,
        active: true as const,
      }
    if (selection === undefined && keyboardSelection === undefined && nativeRange) selection = selectionFromRenderable(document, nativeRange, pane.text.getSelectedText())
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

  /**
   * Shared by every scrollbar-drag gesture site (mouse down on the track, drag, and up): maps a
   * screen Y onto the pane's scroll range and jumps there. lazygit has no scrollbar over the
   * extras view — this is one of githunk's four documented review extensions
   * (docs/lazygit-compatibility-v0.1.md) — so there is no parity behaviour to copy for it clearing
   * the command log's autoscroll. It does so anyway, by the same principle the rest of the FSM
   * already encodes: every explicit user scroll clears the flag, only an explicit jump-to-bottom
   * arms it, and a scrollbar drag is an explicit user scroll
   * (src/ui/panes/command-log-scroll.ts's `"scrollbar"` input).
   */
  private scrollPaneByScrollbarPosition(paneId: FocusId, eventY: number): void {
    const barPane = paneId === "command-log" ? this.commandLog as unknown as PaneHandle : (this.panes as Record<string, PaneHandle>)[paneId]
    const bar = barPane ? paneScrollbar(barPane.text) : undefined
    const win = (this.geometry.windows as Record<string, { x0: number; y0: number; x1: number; y1: number } | undefined>)[paneId === "command-log" ? "log" : paneId]
    if (!bar || !win || !barPane) return
    const barScreenY = (bar as unknown as { screenY: number }).screenY
    const barHeight = (bar as unknown as { height: number }).height as number
    const trackStart = Number.isFinite(barScreenY) ? barScreenY : win.y0 + 1
    const trackSize = Number.isFinite(barHeight) && barHeight > 0 ? barHeight : Math.max(1, win.y1 - win.y0 - 1)
    // Mouse coordinates land on integer cells, so the last track cell is the inclusive endpoint.
    const trackSpan = Math.max(1, trackSize - 1)
    const relative = eventY - trackStart
    const clamped = Math.max(0, Math.min(trackSpan, relative))
    const ratio = trackSize <= 1 ? 0 : clamped / trackSpan
    const range = Math.max(0, bar.scrollSize - bar.viewportSize)
    const newPos = Math.round(ratio * range)
    if (paneId === "main") this.clearNonStickyMainRange()
    barPane.scrollTo(newPos)
    if (paneId === "command-log") this.commandLog.applyScrollInput("scrollbar")
  }

  private activeListView(paneId: ListPaneId): ActiveListView | undefined {
    if (paneId === "files") {
      const state = this.filesView()
      return state === undefined ? undefined : { paneId, viewId: `files:${this.filesPanel.activeTab}`, state }
    }
    if (paneId === "branches") {
      const child = this.branchesPanel.child
      if (child !== undefined) {
        const viewId = child.value.kind === "remote-branches"
          ? `branches-child:${child.value.remote}`
          : `branches-child:local-commits:${child.value.branch}`
        return { paneId, viewId, state: child.view }
      }
      const state = this.branchesPanel.views[this.branchesPanel.activeTab]
      return state === undefined ? undefined : { paneId, viewId: `branches:${this.branchesPanel.activeTab}`, state }
    }
    if (paneId === "commits") {
      const child = this.commitsPanel.child
      if (child !== undefined) return { paneId, viewId: "commit-files", state: child.view }
      const state = this.commitsPanel.views[this.commitsPanel.activeTab]
      return state === undefined ? undefined : { paneId, viewId: `commits:${this.commitsPanel.activeTab}`, state }
    }
    return { paneId, viewId: "stash", state: this.stashState }
  }

  private hoveredIdFor(view: ActiveListView): string | undefined {
    const target = this.hoveredListRow
    if (target === undefined || target.paneId !== view.paneId || target.viewId !== view.viewId) return undefined
    return view.state.rows.some((row) => row.id === target.rowId) ? target.rowId : undefined
  }

  private renderListPane(paneId: ListPaneId): void {
    if (paneId === "branches") this.renderBranchesPane()
    else if (paneId === "commits") this.renderCommitsPane()
    else if (paneId === "files") this.renderFilesPane()
    else this.renderStashPane()
  }

  private setHoveredListRow(next: HoveredListRow | undefined): void {
    const previous = this.hoveredListRow
    if (
      previous?.paneId === next?.paneId &&
      previous?.viewId === next?.viewId &&
      previous?.rowId === next?.rowId
    ) return
    this.hoveredListRow = next
    const previousPane = previous?.paneId
    if (previousPane !== undefined) this.renderListPane(previousPane)
    if (next !== undefined && next.paneId !== previousPane) this.renderListPane(next.paneId)
    this.root.requestRender()
  }

  private updateHoveredListRow(x: number, y: number): void {
    if (this.modalInputActive() || this.isOverVerticalSplitter(x, y) || this.isOverHorizontalSplitter(x, y)) {
      this.setHoveredListRow(undefined)
      return
    }
    const hit = this.findPaneAtPoint(x, y)
    let next: HoveredListRow | undefined
    if (
      hit !== undefined &&
      (hit.id === "files" || hit.id === "branches" || hit.id === "commits" || hit.id === "stash") &&
      this.hitTestScrollbar(x, y) === undefined
    ) {
      const activeView = this.activeListView(hit.id)
      const geometry = this.paneTextGeometry(hit.id)
      const pane = this.panes[hit.id]
      if (activeView !== undefined && geometry !== undefined && pane !== undefined) {
        const row = listRowAtPoint(
          activeView.state,
          { ...geometry, scrollY: pane.text.scrollY },
          x,
          y,
        )
        if (row !== undefined) {
          next = { paneId: activeView.paneId, viewId: activeView.viewId, rowId: row.id }
        }
      }
    }
    this.setHoveredListRow(next)
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
        const active = panel.activeTab
        const view = panel.views[active]
        if (!view) return
        const nextView = selectListRow(view, stableId)
        if (nextView !== view) {
          this.commitsPanel = updatePanelView(panel, active, nextView)
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
          this.branchActionGeneration += 1
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
          this.branchActionGeneration += 1
          this.renderBranchesPane()
          this.revealListRow("branches", this.panes.branches, nextView.selectedIndex)
          this.syncPreviewForFocus("branches")
        }
      }
      this.root.requestRender()
      return
    }
    if (paneId === "files") {
      const panel = this.filesPanel
      const active = panel.activeTab
      const view = panel.views[active]
      if (view === undefined) return
      const next = selectListRow(view, stableId)
      if (next !== view) {
        this.filesPanel = updatePanelView(panel, active, next)
        this.renderFilesPane()
        this.revealListRow("files", this.panes.files, next.selectedIndex)
        if (active === "files") {
          const row = this.selectedFileRow()
          this.panes.files.box.bottomTitle = row?.path ?? stableId
          if (row?.kind === "file") this.onSelectFile?.(row.path)
          this.mainGate.installSynchronous(this.presentFilesContent(this.model))
        } else {
          this.syncPreviewForFocus("files")
        }
      }
      this.root.requestRender()
      return
    }
    if (paneId === "stash") {
      const next = selectListRow(this.stashState, stableId)
      if (next !== this.stashState) {
        this.stashState = next
        this.renderStashPane()
        this.revealListRow("stash", this.panes.stash, next.selectedIndex)
        this.syncPreviewForFocus("stash")
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
      this.actionInspect()
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
    // An in-flight inline status would otherwise keep its interval — and the process — alive.
    this.stopSpinner()
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
      if (this.isBranchReviewActive?.()) return
      const eventType = event.type as string
      if (eventType === "out") {
        if (this.gestureOwner === undefined) this.setHoveredListRow(undefined)
        return
      }
      if (eventType === "over" || eventType === "move") {
        if (this.gestureOwner === undefined) this.updateHoveredListRow(event.x, event.y)
        return
      }
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
              // Over the command log the wheel is not just a scroll: lazygit binds MouseWheelUp/
              // MouseWheelDown on the extras view to `scrollUpExtra`/`scrollDownExtra`
              // (pkg/gui/keybindings.go:248-258), the same handlers `,`/`.` use, and both assign
              // `Autoscroll = false` (pkg/gui/extras_panel.go:49,57) before scrolling. This is the
              // only wheel dispatcher in the app, so the transition has to be applied here.
              if (hit.id === "main") this.clearNonStickyMainRange()
              if (hit.id === "command-log") this.commandLog.applyScrollInput(signed < 0 ? "scroll-up" : "scroll-down")
              pane.scrollBy(signed * 2 * delta)
            }
            this.updateHoveredListRow(event.x, event.y)
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
          if (event.type === "drag") {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            this.scrollPaneByScrollbarPosition(owner.paneId, event.y)
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.type === "up") {
            this.scrollPaneByScrollbarPosition(owner.paneId, event.y)
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
        if (owner.kind === "list-range") {
          if (event.type === "drag") {
            const active = this.activeListView(owner.paneId)
            const geometry = this.paneTextGeometry(owner.paneId)
            const pane = this.panes[owner.paneId]
            if (active?.viewId === owner.viewId && geometry !== undefined) {
              const row = listRowAtPoint(active.state, { ...geometry, scrollY: pane.text.scrollY }, event.x, event.y)
              if (row !== undefined) {
                const next = setListRangeSelection(active.state, owner.anchorId, row.id)
                if (next !== active.state) {
                  this.updateActiveListState(owner.paneId, next)
                  this.renderListPane(owner.paneId)
                  this.revealListRow(owner.paneId, pane, next.selectedIndex)
                  this.syncListSelectionAfterChange(owner.paneId)
                  this.root.requestRender()
                }
              }
            }
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.type === "up" || (event.type as string) === "cancel") {
            this.gestureOwner = undefined
            event.preventDefault()
            event.stopPropagation()
            return
          }
          event.stopPropagation()
          return
        }
      }
      if (event.type === "down") {
        this.updateHoveredListRow(event.x, event.y)
        if (this.modalInputActive()) {
          this.cancelGesture()
          return
        }
        const scrollbarHit = this.hitTestScrollbar(event.x, event.y)
        if (scrollbarHit !== undefined) {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          this.gestureOwner = { kind: "scrollbar", paneId: scrollbarHit }
          this.scrollPaneByScrollbarPosition(scrollbarHit, event.y)
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
        // A plain left click on the top border row activates a tab — gocui/gui.go:1807.
        const tabsGeometry = this.paneTabsGeometryFor(paneId)
        const tabWindow = (this.geometry.windows as unknown as Record<string, { x0: number; y0: number } | undefined>)[hit.winName]
        if (tabsGeometry !== undefined && tabWindow !== undefined && event.y === tabWindow.y0) {
          const tabIndex = paneTabAtOffset(tabsGeometry, event.x - tabWindow.x0)
          if (tabIndex !== undefined) {
            this.pendingClick = undefined
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            this.selectPaneTab(paneId, tabIndex)
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        if (tabsGeometry === undefined && tabWindow !== undefined && event.y === tabWindow.y0) {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (paneId === "main") {
          const rangeState = getMainDiffLineRangeState(this.panes.main)
          if (rangeState !== undefined && rangeState.rangeMode !== "none") setMainDiffLineRangeState(this.panes.main, clearDiffLineRange(rangeState))
        }
        if (paneId === "main") {
          this.pendingClick = undefined
          this.lastSplitterPress = undefined
          this.gestureOwner = { kind: "main-selection" }
          if (this.focusManager.active !== "main") this.focusManager.focus("main")
          this.clearTransientMenus()
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
            listState = panel.views[panel.activeTab]
            viewIdForDouble = `commits:${panel.activeTab}`
          }
        } else if (paneId === "branches") {
          const panel = this.branchesPanel
          if (panel.child !== undefined) {
            listState = panel.child.view
            viewIdForDouble = panel.child.value.kind === "remote-branches"
              ? `branches-child:${panel.child.value.remote}`
              : `branches-child:local-commits:${panel.child.value.branch}`
          } else {
            listState = panel.views[panel.activeTab]
            viewIdForDouble = `branches:${panel.activeTab}`
          }
        } else if (paneId === "files") {
          listState = this.filesView()
          viewIdForDouble = `files:${this.filesPanel.activeTab}`
        } else if (paneId === "stash") {
          listState = this.stashState
          viewIdForDouble = "stash"
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
            const arrowRow = paneId === "files" ? this.filesTreeArrowRowAt(stableId, event.x, geometry.screenX) : undefined
            const isDouble = pending !== undefined && pending.viewId === viewIdForDouble && pending.stableId === stableId && now - pending.at <= DOUBLE_CLICK_MS && Math.abs(pending.x - event.x) <= 1 && Math.abs(pending.y - event.y) <= 1
            if (isDouble) {
              this.pendingClick = undefined
              this.lastSplitterPress = undefined
              if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
              this.selectRowForPane(paneId, stableId)
              if (paneId === "files" || paneId === "branches" || paneId === "commits" || paneId === "stash") {
                const active = this.activeListView(paneId)
                if (active !== undefined) this.gestureOwner = { kind: "list-range", paneId, viewId: active.viewId, anchorId: stableId }
              }
              event.preventDefault()
              event.stopPropagation()
              if (pending.arrowToggled !== true) this.handleDoubleClick(paneId)
              return
            }
            this.pendingClick = { viewId: viewIdForDouble, stableId, x: event.x, y: event.y, at: now, ...(arrowRow === undefined ? {} : { arrowToggled: true }) }
            this.lastSplitterPress = undefined
            if (this.focusManager.active !== paneId) this.focusManager.focus(paneId)
            this.selectRowForPane(paneId, stableId)
            if (paneId === "files" || paneId === "branches" || paneId === "commits" || paneId === "stash") {
              const active = this.activeListView(paneId)
              if (active !== undefined) this.gestureOwner = { kind: "list-range", paneId, viewId: active.viewId, anchorId: stableId }
            }
            if (arrowRow !== undefined) {
              // files_controller.go:232-242 toggles only the arrow and its trailing space.
              this.applyFilesTree(toggleFileTreeCollapsedPath(this.filesTree, arrowRow.internalPath))
            }
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

  /**
   * Shared by the horizontal splitter's double-click gesture (the counterpart to the vertical
   * splitter's double-click collapse, see toggleSideCollapsed above) and the command-log menu's
   * `t` item (pkg/gui/extras_panel.go:19-29): if the log is shown and focused, pop focus back to
   * the last side pane first — otherwise focus would point at a window that just disappeared —
   * then flip visibility and persist it exactly as `gui.c.GetAppState().HideCommandLog = !show;
   * SaveAppStateAndLogError()` does (:26-27).
   */
  private toggleCommandLog(): void {
    if (this.focusManager.logVisible && this.focusManager.active === "command-log") {
      this.focusManager.focus(this.focusManager.lastSide)
    }
    this.focusManager.setLogVisible(!this.focusManager.logVisible)
    this.notifyGeometry()
  }

  /**
   * lazygit's `@` menu (pkg/gui/extras_panel.go:12-38). Labels are `Tr.CommandLog`,
   * `Tr.ToggleShowCommandLog` and `Tr.FocusCommandLog` verbatim
   * (pkg/i18n/english.go:1946,1949-1950).
   */
  private openCommandLogMenu(): void {
    this.actionMenu.openMenu("Command log", [
      { key: "t", label: "Toggle show/hide command log", onPress: () => this.toggleCommandLog() },
      {
        key: "f",
        label: "Focus command log",
        onPress: () => {
          // lazygit's handleFocusCommandLog (extras_panel.go:40-46) is a transient runtime
          // reveal, not a persisted choice: it calls SetShowExtrasWindow(true) then pushes the
          // context, but unlike `t`'s OnPress (:24-27) it never assigns
          // gui.c.GetAppState().HideCommandLog nor calls SaveAppStateAndLogError(). So `f` shows a
          // hidden log for this session only; on the next launch visibility reverts to whatever
          // `t` last persisted. Do NOT add a notifyGeometry() call here to "restore" persistence —
          // that would re-introduce the bug where pressing `f` once makes the log visible on every
          // subsequent launch.
          //
          // Bare-assign logVisible (the same shape applyPersistedGeometry uses above) rather than
          // setLogVisible(true), so the onChange cascade — refreshCommandLog, applyFocus, pane
          // renders, recomputeLayout, syncPreviewForFocus — fires once, via focus() below, instead
          // of once per call.
          this.focusManager.logVisible = true
          this.focusManager.focus("command-log")
        },
      },
    ])
    this.recomputeLayout()
  }


  private applyFocus(active: FocusId): void {
    for (const pane of Object.values(this.panes)) pane.setFocused(pane.id === active)
    // lazygit re-arms autoscroll when the command log loses focus
    // (pkg/gui/controllers/command_log_controller.go:29-33).
    const wasFocused = this.commandLogFocused
    this.commandLogFocused = active === "command-log"
    if (wasFocused && !this.commandLogFocused) this.commandLog.applyScrollInput("focus-lost")
    this.commandLog.setFocused(this.commandLogFocused)
  }

  private recomputeLayout(): void {
    const previous = this.geometry
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
    const sideGeometryChanged = SIDE_WINDOWS.some((name) => {
      const before = previous.windows[name]
      const after = this.geometry.windows[name]
      return before?.x0 !== after?.x0 || before?.y0 !== after?.y0 || before?.x1 !== after?.x1 || before?.y1 !== after?.y1
    })
    if (sideGeometryChanged) this.renderSidePanes()
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
    // Lazygit's infoSectionChildren hides appStatus/information/options when InSearchPrompt
    // (window_arrangement_helper.go:281). Githunk's equivalent is filterStatusForHints() !== undefined:
    // the global bottom row is then the search bar (searchPrefix + search) spanning full width,
    // not hints + review status. Return 0 to make the 'info' window zero-width.
    if (this.filterStatusForHints() !== undefined) return 0
    return reviewStatusText(this.model).length
  }

  private syncPaneBorders(): void {
    // Mirrors lazygit's setSearchingFrameColor / setNonSearchingFrameColor (search_helper.go:321).
    // ActiveBorderColor is green+bold, SearchingActiveBorderColor is cyan+bold (user_config.go:885).
    const focused = this.focusManager.active
    const isFiltering = this.filterStatusForHints() !== undefined
    for (const id of FOCUS_IDS) {
      const pane = (this.panes as Record<string, PaneHandle | undefined>)[id]
      if (!pane) continue
      const isFocused = id === focused
      if (isFocused && isFiltering) {
        pane.box.borderColor = ANSI_CYAN
        pane.box.titleColor = ANSI_CYAN
      } else if (isFocused) {
        pane.box.borderColor = ANSI_GREEN
        // Keep title green only for non-tabbed panes; tabbed panes color via PaneTabsBoxRenderable
        if (pane.box.titleColor === ANSI_CYAN) pane.box.titleColor = ANSI_GREEN
      } else {
        pane.box.borderColor = DEFAULT_FOREGROUND
        if (pane.box.titleColor === ANSI_CYAN || pane.box.titleColor === ANSI_GREEN) pane.box.titleColor = DEFAULT_FOREGROUND
      }
    }
  }

  private applyLayout(): void {
    this.syncPaneBorders()
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
      // What the main pane shows does not depend on geometry — except for the "Terminal too
      // small" swap — so only that transition reinstalls. A resize still moves the scroll
      // bounds, which is all the other branch has to answer for. (Reinstalling unconditionally
      // meant every focus change, splitter drag and resize re-pushed the whole patch.)
      if (this.geometry.tooSmall !== this.installedMainTooSmall) {
        this.installedMainTooSmall = this.geometry.tooSmall
        installMainPaneContent(this.panes.main, this.installedMainContent, this.geometry.tooSmall)
      } else {
        clampMainScroll(this.panes.main)
      }
    }

    place(this.hintsBar.hints, "hints")
    place(this.hintsBar.status, "info")
    const hintsWidth = widthOf(windows.hints)
    const filterStatus = this.filterStatusForHints()
    if (filterStatus !== undefined) {
      // Lazygit's search view lives at the global bottom (window_arrangement_helper.go:281):
      // InSearchPrompt true => bottom is searchPrefix (size of prefix) + search (weight 1),
      // with no appStatus/information/options. Githunk's hints+info becomes a single full-width
      // search bar (statusWidth 0 above), so show only the filter/search text and hide review status.
      this.hintsBar.update(filterStatus.hints, filterStatus.status)
    } else {
      this.hintsBar.update(
        hintsWidth === 0 ? "" : this.registry.hintsFor(this.focusManager.active, this.model, this.uiState(), hintsWidth),
        reviewStatusText(this.model),
      )
    }

    if (this.menuOpen) {
      this.keybindingMenu.update(
        this.registry.menuFor(this.focusManager.active, this.model, this.uiState()),
        paneTitleFor(this.focusManager.active),
      )
      this.keybindingMenu.layout(this.geometry.terminalWidth, this.geometry.terminalHeight)
    }
    this.keybindingMenu.box.visible = this.menuOpen
    this.actionMenu.layout(this.geometry.terminalWidth, this.geometry.terminalHeight)
    this.commitMessagePanel.layout(this.geometry.terminalWidth, this.geometry.terminalHeight)
    this.promptPopup.layout(this.geometry.terminalWidth, this.geometry.terminalHeight)
    this.root.requestRender()
  }
}
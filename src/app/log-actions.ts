/**
 * lazygit's action labels, copied verbatim from its `Actions` translations
 * (pkg/i18n/english.go:2128-2254). An action groups the commands logged under it — "typically
 * there's only one command under an action but there may be more"
 * (pkg/gui/command_log_panel.go:14-24).
 *
 * Only actions that reach git get one here — githunk's own scoping choice, not a rule lazygit
 * itself follows: lazygit labels its main-pane copy-to-clipboard even though it runs zero git
 * commands (`Actions.CopySelectedTextToClipboard`, `patch_explorer_controller.go:343-351`;
 * `english.go:2204`; same shape at `basic_commits_controller.go:294`). githunk's own review
 * actions (marking a file reviewed, changing the compare base) are excluded on that same
 * git-reaching basis. Whether githunk's `Ctrl+O`/`y` copy path (main-pane selection copy, the
 * headline review extension) should get a matching label is a known, deliberately deferred gap —
 * not covered by this round.
 */
export const LOG_ACTIONS = {
  /** files_controller.go:544, called from toggleStaged (:509-565); english.go:2175 */
  stageFile: "Stage file",
  /** files_controller.go:559, called from toggleStaged (:509-565); english.go:2177 */
  unstageFile: "Unstage file",
  /** files_controller.go:921-960 -> toggleStaged(:544); english.go:2179 */
  stageAllFiles: "Stage all files",
  /** files_controller.go:921-960 -> toggleStaged(:559); english.go:2178 */
  unstageAllFiles: "Unstage all files",
  /**
   * files_controller.go:1770; english.go:2174. githunk's `discardFile` runs `git restore --
   * <path>` (`src/git/mutations.ts:50`), which without `--staged` restores the worktree from the
   * index, leaving staged content untouched — and `src/ui/root-view.ts:1511` refuses discard on
   * purely-staged content outright. That is lazygit's *unstaged* discard
   * (`DiscardAllUnstagedChangesInFile`, :2174), not its all-changes one (`DiscardAllChangesInFile`,
   * :2173, `files_controller.go:1744`), so this uses the unstaged label. The missing "in" before
   * "selected" is upstream's own typo in `english.go:2174` — reproduced verbatim for parity, not a
   * mistake to "fix" here.
   */
  discardAllUnstagedChangesInFile: "Discard all unstaged changes selected file(s)",
  /**
   * staging_controller.go:239-265; english.go:2215. Both staging and discarding a selection:
   * `DiscardSelection` (:213) routes through `applySelectionAndRefresh(true)` into the same
   * `applySelection`, so lazygit labels the two identically. (:332 is `editHunk`, a feature
   * githunk does not have.)
   */
  applyPatch: "Apply patch",
  /** english.go:2192 */
  commit: "Commit",
  /** amend_helper.go:22; english.go:2151 */
  amendCommit: "Amend commit",
  /** sync_controller.go:197; english.go:2193 */
  push: "Push",
  /** sync_controller.go:119; english.go:2194 */
  pull: "Pull",
  /** files_controller.go:1541 — a hardcoded string in lazygit, not an `Actions` entry. */
  fetch: "Fetch",
  /** branches_controller.go:417,516; english.go:2134 */
  checkoutBranch: "Checkout branch",
  /** english.go:2142 */
  createBranch: "Create branch",
  /** english.go:2137 */
  deleteLocalBranch: "Delete local branch",
  /** english.go:2141 */
  renameBranch: "Rename branch",
  /** english.go:2210 */
  setBranchUpstream: "Set branch upstream",
  /** files_controller.go:1282,1482 -> handleStashSave(:1516); english.go:2196 */
  stashAllChanges: "Stash all changes",
  /**
   * files_controller.go:1300 -> handleStashSave(:1516); english.go:2200. githunk has no
   * staged-only stash, but does have the untracked-files distinction lazygit labels here — see
   * `createStash` in controller.ts.
   */
  stashIncludeUntrackedChanges: "Stash all changes including untracked files",
  /** stash_controller.go:127; english.go:2218 */
  applyStash: "Apply stash",
  /** stash_controller.go:141; english.go:2217 */
  popStash: "Pop stash",
  /** stash_controller.go:169; english.go:2219 */
  dropStash: "Drop stash",
  /** files_helper.go:78; english.go:2195 */
  openFile: "Open file",
} as const

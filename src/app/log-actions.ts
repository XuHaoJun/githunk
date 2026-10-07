/**
 * lazygit's action labels, copied verbatim from its `Actions` translations
 * (pkg/i18n/english.go:2195-2321). An action groups the commands logged under it — "typically
 * there's only one command under an action but there may be more"
 * (pkg/gui/command_log_panel.go:14-24).
 *
 * Only actions that reach git get one here — githunk's own scoping choice, not a rule lazygit
 * itself follows: lazygit labels its main-pane copy-to-clipboard even though it runs zero git
 * commands (`Actions.CopySelectedTextToClipboard`, `main_view_controller.go:486-499`;
 * `english.go:2271`; same shape at `basic_commits_controller.go:294`). githunk's own review
 * actions (marking a file reviewed, changing the compare base) are excluded on that same
 * git-reaching basis. Whether githunk's `Ctrl+O`/`y` copy path (main-pane selection copy, the
 * headline review extension) should get a matching label is a known, deliberately deferred gap —
 * not covered by this round.
 */
export const LOG_ACTIONS = {
  /** files_controller.go:544, called from toggleStaged (:509-565); english.go:2242 */
  stageFile: "Stage file",
  /** files_controller.go:559, called from toggleStaged (:509-565); english.go:2244 */
  unstageFile: "Unstage file",
  /** files_controller.go:920-959 -> toggleStaged(:544); english.go:2246 */
  stageAllFiles: "Stage all files",
  /** files_controller.go:920-959 -> toggleStaged(:559); english.go:2245 */
  unstageAllFiles: "Unstage all files",
  /**
   * files_controller.go:1769; english.go:2241. githunk's `discardFile` runs `git restore --
   * <path>` (`src/git/mutations.ts:50`), which without `--staged` restores the worktree from the
   * index, leaving staged content untouched — and `src/ui/root-view.ts:1511` refuses discard on
   * purely-staged content outright. That is lazygit's *unstaged* discard
   * (`DiscardAllUnstagedChangesInFile`, :2241), not its all-changes one (`DiscardAllChangesInFile`,
   * :2240, `files_controller.go:1743`), so this uses the unstaged label. The missing "in" before
   * "selected" is upstream's own typo in `english.go:2241` — reproduced verbatim for parity, not a
   * mistake to "fix" here.
   */
  discardAllUnstagedChangesInFile: "Discard all unstaged changes selected file(s)",
  /** english.go:2240 */
  discardAllChangesInFile: "Discard all changes in selected file(s)",

  /** files_controller.go:1804-1824; english.go:2289 */
  resetSubmodule: "Reset submodule",
  /**
   * working_tree_diff_actions.go:211-259 (`applyDiffLineSelection`); english.go:2282. Both staging
   * and discarding a selection: `PrimaryAction` (:56) and `DiscardSelection` (:76) route into the
   * same `applyDiffLineSelection`, so lazygit labels the two identically. (:164 is `EditHunk`, a
   * feature githunk does not have.)
   */
  applyPatch: "Apply patch",
  /** english.go:2259 */
  commit: "Commit",
  /** amend_helper.go:22; english.go:2218 */
  amendCommit: "Amend commit",
  /** sync_controller.go:476; english.go:2260 */
  push: "Push",
  /** sync_controller.go:272,380; english.go:2261 */
  pull: "Pull",
  /** files_controller.go:1540 — a hardcoded string in lazygit, not an `Actions` entry. */
  fetch: "Fetch",
  /** branches_controller.go:418,517; english.go:2201 */
  checkoutBranch: "Checkout branch",
  /** english.go:2209 */
  createBranch: "Create branch",
  /** english.go:2204 */
  deleteLocalBranch: "Delete local branch",
  /** english.go:1789 */
  deleteRemoteBranch: "Delete remote branch",
  /** english.go:2120 */
  removeWorktree: "Remove worktree",
  /** english.go:2208 */
  renameBranch: "Rename branch",
  /** english.go:2277 */
  setBranchUpstream: "Set branch upstream",
  /** files_controller.go:1281,1481 -> handleStashSave(:1508); english.go:2263 */
  stashAllChanges: "Stash all changes",
  /**
   * files_controller.go:1299 -> handleStashSave(:1508); english.go:2267. githunk has no
   * staged-only stash, but does have the untracked-files distinction lazygit labels here — see
   * `createStash` in controller.ts.
   */
  stashIncludeUntrackedChanges: "Stash all changes including untracked files",
  /** stash_controller.go:130; english.go:2285 */
  applyStash: "Apply stash",
  /** stash_controller.go:144; english.go:2284 */
  popStash: "Pop stash",
  /** stash_controller.go:172; english.go:2286 */
  dropStash: "Drop stash",
  /** files_helper.go:86; english.go:2262 */
  openFile: "Open file"
} as const

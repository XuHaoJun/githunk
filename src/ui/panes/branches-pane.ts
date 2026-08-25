import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { ItemOperation } from "../../domain/item-operation"
import type { PullRequest } from "../../domain/pull-request"
import { shouldShowPullRequest } from "../../domain/pull-request"
import { filterItems } from "../../app/filter"
import { branchStatus, formatRecency } from "../branch-status"
import { pullRequestIcon } from "../pull-request-icon"
import { BRANCH_RECENCY_CURRENT_FG, BRANCH_RECENCY_FG } from "../theme"
import { createPane, type PaneHandle } from "./common"
import type { ListColumn, ListRow } from "../list-view"
import { createListState, renderListRows, selectListRow, setListRows, type ListState } from "../list-view"

/**
 * What a local-branch row is drawn from beyond the model: the clock the recency and spinner are
 * read off, the operations currently running against rows, and the pull requests to dot them with.
 */
export type BranchRowOptions = {
  readonly now?: Date
  /** Row id (`local:<name>`) → the operation in flight on it. */
  readonly itemOperations?: ReadonlyMap<string, ItemOperation>
  /** Branch name → its pull request, as `pullRequestsByBranch` keys them. */
  readonly pullRequests?: Readonly<Record<string, PullRequest>>
  /**
   * Clock for the spinner, split from `now` so a test can hold the recency still while stepping
   * frames. Defaults to `now`.
   */
  readonly spinnerNowMs?: number
}

/**
 * lazygit's `getBranchDisplayStrings` in its default (normal-screen) configuration —
 * pkg/gui/presentation/branches.go:45-191: recency, then the pull-request dot, then the name with
 * its branch status. `gui.showBranchCommitHash` and `gui.showDivergenceFromBaseBranch` are off by
 * default (pkg/config/user_config.go:916-917), so neither the hash nor the base-branch divergence
 * cell exists here.
 *
 * The upstream and subject cells are githunk's own, at the priorities that make them the first
 * things ../list-view sheds when the panel narrows; lazygit shows both only in half/full screen
 * mode (its `fullDescription` branch, :180-190).
 */
export function localBranchRows(model: AppModel, filter = "", options: BranchRowOptions = {}): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const now = options.now ?? new Date()
  const nowUnix = Math.floor(now.getTime() / 1000)
  const spinnerNowMs = options.spinnerNowMs ?? now.getTime()
  const pullRequests = options.pullRequests
  // Lazygit orders branches by committer date descending (default `localBranchSortOrder: "date"` →
  // `-committerdate`), with the current branch pinned to the top regardless of date
  // (pkg/commands/git_commands/branch_loader.go:103-110). Recency ordering (`"recency"` mode merges
  // reflog recency) is not replicated here.
  const sortedBranches = [...listing.localBranches].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const aTime = Number(a.committedAt ?? "0")
    const bTime = Number(b.committedAt ?? "0")
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime
    return a.name.localeCompare(b.name)
  })
  const rows: ListRow[] = sortedBranches.map((branch) => {
    const id = `local:${branch.name}`
    const columns: ListColumn[] = []
    // The checked-out branch's recency is the literal "  *" (branch_loader.go:106).
    columns.push({
      text: branch.isCurrent ? "  *" : formatRecency(branch.committedAt, nowUnix),
      priority: 0,
      color: branch.isCurrent ? BRANCH_RECENCY_CURRENT_FG : BRANCH_RECENCY_FG,
    })
    const pullRequest = pullRequests === undefined ? undefined : Object.prototype.hasOwnProperty.call(pullRequests, branch.name) ? pullRequests[branch.name] : undefined
    const icon = pullRequest !== undefined && shouldShowPullRequest(pullRequest, branch.name) ? pullRequestIcon(pullRequest) : undefined
    // Always a cell, blank when there is no pull request: ../list-view pads each column to its
    // widest cell, so a per-row absence must not shift the names of the rows around it. A list
    // where *every* cell is blank is dropped whole, so a repo without pull requests loses nothing.
    columns.push({ text: icon?.text ?? "", priority: 0, ...(icon?.color === undefined ? {} : { color: icon.color }) })
    columns.push({ text: branch.name, priority: 2, flex: true })
    // Every cell below is present on every row, blank where the branch has nothing to put in it:
    // ../list-view addresses columns by index and pads each to its widest cell, so a row that
    // omitted one would shift every later cell of that row into the wrong column.
    const status = branchStatus(branch, options.itemOperations?.get(id), spinnerNowMs)
    columns.push({ text: status?.text ?? "", priority: 3, ...(status === undefined ? {} : { color: status.color }) })
    columns.push({ text: branch.upstream === undefined || branch.upstream.length === 0 ? "" : `↳${branch.upstream}`, priority: 5, style: "dim" })
    columns.push({ text: branch.subject ?? "", priority: 4 })
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[2]?.text ?? row.id)]
}

/** branches_controller.go:205 `self.c.Tr.NoBranchesThisRepo` — pkg/i18n/english.go:1315. */
export const NO_BRANCHES_THIS_REPO = "No branches for this repo"

/** Panel 3's tab labels and jump label, in lazygit's order (pkg/gui/views.go side-panel groups). */
export const BRANCHES_TABS = ["Local Branches", "Remotes", "Tags"] as const
export const BRANCHES_JUMP_KEY = "3"

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "", "", false, {
    tabs: { jumpKey: BRANCHES_JUMP_KEY, tabs: BRANCHES_TABS },
  })
  const rows = localBranchRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const state = createListState(rows, displayRows)
  const content = renderListRows(state, false, 80)
  pane.update(content)
  pane.syncScrollbar()
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean, filter = ""): ListState {
  const rows = localBranchRows(model, filter)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

// --- Compatibility shims for pre-Task4 callers (dispatch.integration) ---
export type BranchPaneItem =
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "remote"; readonly name: string }
  | { readonly kind: "remote-branch"; readonly remote: string; readonly name: string; readonly ref: string }

export function branchItemId(item: BranchPaneItem): string {
  return item.kind === "remote-branch" ? `${item.kind}:${item.remote}:${item.name}` : `${item.kind}:${item.name}`
}

export function branchPaneItems(model: AppModel, filter = ""): readonly BranchPaneItem[] {
  const listing = model.branches
  if (listing === undefined) return []
  const all = [
    ...listing.localBranches.map((branch) => ({ kind: "local" as const, name: branch.name })),
    ...listing.remotes.flatMap((remote) => [
      { kind: "remote" as const, name: remote.name },
      ...(remote.branches ?? []).map((branch) => ({ kind: "remote-branch" as const, remote: remote.name, name: branch.name, ref: branch.ref })),
    ]),
  ]
  return filterItems(filter, all, (item) => item.name)
}

export function selectedBranchItem(model: AppModel, index: number, filter = ""): BranchPaneItem | undefined {
  const items = branchPaneItems(model, filter)
  return items[Math.max(0, Math.min(index, items.length - 1))]
}

export function moveBranchesCursor(model: AppModel, index: number, direction: "next" | "previous", filter = ""): number {
  const count = branchPaneItems(model, filter).length
  if (count === 0) return 0
  return Math.max(0, Math.min(count - 1, index + (direction === "next" ? 1 : -1)))
}

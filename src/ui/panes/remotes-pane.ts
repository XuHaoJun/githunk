import type { AppModel } from "../../app/model"
import type { Remote } from "../../domain/branch"
import type { ItemOperation } from "../../domain/item-operation"
import { itemOperationLabel } from "../../domain/item-operation"
import { filterItems } from "../../app/filter"
import { loaderFrame } from "../loader"
import { BRANCH_ITEM_OPERATION_FG } from "../theme"
import type { ListRow } from "../list-view"
import { createListState, renderListRows, setListRows, type ListState } from "../list-view"
import type { PaneHandle } from "./common"

/** remotes_controller.go:107. */
export const NO_REMOTES = "No remotes"

/** remote_branches_controller.go:120. */
export const NO_BRANCHES_FOR_REMOTE = "No branches for this remote"

/**
 * remotes_controller.go:109-112:
 *
 *     content := fmt.Sprintf("%s\nUrls:\n%s", style.FgGreen.Sprint(remote.Name), strings.Join(remote.Urls, "\n"))
 *     if len(remote.PushUrls) > 0 { content += fmt.Sprintf("\nPush Urls:\n%s", …) }
 *
 * lazygit's model keeps `Urls` and `PushUrls` as lists (a remote may configure several of each);
 * githunk's `Remote` keeps one of each, so each block holds a single line. The `Push Urls:` block
 * is omitted when the push URL is the fetch URL, which is the case git reports whenever no
 * `remote.<name>.pushurl` is set.
 */
export function remotePreviewText(remote: Remote): string {
  let content = `${remote.name}\nUrls:\n${remote.fetchUrl ?? ""}`
  if (remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl) content += `\nPush Urls:\n${remote.pushUrl}`
  return content
}

export type RemoteRowOptions = {
  /** Row id (`remote:<name>`) → the operation in flight on it. */
  readonly itemOperations?: ReadonlyMap<string, ItemOperation>
  readonly spinnerNowMs?: number
}

/**
 * `getRemoteDisplayStrings` — pkg/gui/presentation/remotes.go:29-56 — appends the operation and
 * spinner in cyan to the row's description while a fetch of that remote is running. The URL cells
 * are githunk's own; lazygit's description cell is a blue `N branches`, which githunk cannot fill
 * because it loads a remote's branches on drill-down rather than on refresh.
 */
export function remoteRows(model: AppModel, filter = "", options: RemoteRowOptions = {}): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const spinnerNowMs = options.spinnerNowMs ?? Date.now()
  const rows: ListRow[] = listing.remotes.map((remote) => {
    const id = `remote:${remote.name}`
    const operation = options.itemOperations?.get(id)
    const columns: ListRow["columns"] = [
      { text: remote.name, priority: 2 },
      ...(operation === undefined ? [] : [{ text: `${itemOperationLabel(operation)} ${loaderFrame(spinnerNowMs)}`, priority: 1, color: BRANCH_ITEM_OPERATION_FG }]),
      ...(remote.fetchUrl ? [{ text: remote.fetchUrl, priority: 4, style: "dim" as const }] : []),
      ...(remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl ? [{ text: remote.pushUrl, priority: 4, style: "dim" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}

export function remoteBranchRows(model: AppModel, remote: string, filter = ""): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const remoteEntry = listing.remotes.find((r) => r.name === remote)
  if (remoteEntry?.branches === undefined) return []
  const rows: ListRow[] = remoteEntry.branches.map((branch) => {
    const id = `remote-branch:${branch.ref}`
    const columns: ListRow["columns"] = [
      { text: branch.name, priority: 2 },
      { text: branch.ref, priority: 3, style: "dim" as const },
      ...(branch.oid ? [{ text: branch.oid.slice(0, 7), priority: 1, style: "yellow" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}

export function updateRemotesPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean): ListState {
  const rows = remoteRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No remotes" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

export function updateRemoteBranchesPane(pane: PaneHandle, model: AppModel, remote: string, state: ListState, focused: boolean): ListState {
  const rows = remoteBranchRows(model, remote)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

// Backward compat: initial state helper for tests
export function createRemotesState(model: AppModel): ListState {
  const rows = remoteRows(model)
  return createListState(rows, rows.length === 0 ? [{ kind: "message", text: "No remotes" }] : undefined)
}
